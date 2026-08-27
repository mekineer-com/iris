import {approxBase64ByteLength} from "./audioHelpers"
import type {OpenAlmaConfig} from "./openAlmaConfig"
import type {SessionMode} from "../shared/types"

type StartResponse = {
  session_id: string
  next_transcript_sequence: number
  ephemeral_token: string
  websocket: {
    api_version: string
    method: string
    input_audio_rate_hz: number
    output_audio_rate_hz: number
  }
  lease_seconds: number
}

export type GeminiCallbacks = {
  onAudio: (base64Pcm: string) => void
  onTurnComplete: (finalResponse: boolean) => void
  onInterrupted: () => void
  onPersistenceError: (message: string | null) => void
  onError: (error: Error) => void
}

type TranscriptEvent = {
  event_id: string
  sequence: number
  event_kind: "transcript" | "sitting_summary"
  role: "user" | "assistant"
  content: string
  status?: "complete" | "interrupted"
}

type PendingToolCall = {
  generation: number
  sessionId: string
  response?: string
}

function trace(event: string, detail: Record<string, unknown> = {}): void {
  if (process.env.NODE_ENV === "test") return
  console.info(`[OpenAlma] ${new Date().toISOString()} ${event}`, detail)
}

type SocketLike = {
  readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: any) => void): void
}

export type GeminiLiveControllerOptions = {
  fetchFn?: typeof fetch
  openSocket?: (url: string) => SocketLike
  setupTimeoutMs?: number
  heartbeatMs?: number
}

const WS_OPEN = 1
const REQUEST_TIMEOUT_MS = 10_000
const RECALL_TIMEOUT_MS = 30_000
const REFLECTION_TIMEOUT_MS = 8_000
export const SITTING_REFLECTION_PROMPT =
  "Reflect briefly in first person on the emotional tone, subtext, or meaningful shift in this sitting that the literal transcript may not preserve. Do not recap the conversation. Respond with one or two natural sentences, or exactly NO_SUMMARY if nothing worthwhile would be added."

export class GeminiLiveController {
  private readonly fetchFn: typeof fetch
  private readonly openSocket: (url: string) => SocketLike
  private readonly setupTimeoutMs: number
  private readonly heartbeatMs?: number
  private socket: SocketLike | null = null
  private token = ""
  private sessionId = ""
  private nextTranscriptSequence = 1
  private resumptionHandle = ""
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private stopping = false
  private ended = true
  private reconnectAttempted = false
  private errorReported = false
  private inputTranscript = ""
  private outputTranscript = ""
  private interruptionFinalized = false
  private turnActive = false
  private completeUserTurns = 0
  private pendingEvents: TranscriptEvent[] = []
  private appendTail: Promise<void> = Promise.resolve()
  private persistenceFatal = false
  private reflecting = false
  private reflectionResolve: ((value: string | null) => void) | null = null
  private stopPromise: Promise<void> | null = null
  private generation = 0
  private ready = false
  private pendingToolCalls = new Map<string, PendingToolCall>()
  private deliveredToolResultIds = new Set<string>()
  private audioFramesSent = 0
  private providerAudioChunks = 0
  private mode: SessionMode = "continuous"

  constructor(
    private readonly config: OpenAlmaConfig,
    private readonly callbacks: GeminiCallbacks,
    options: GeminiLiveControllerOptions = {},
  ) {
    this.fetchFn = options.fetchFn ?? fetch
    this.openSocket = options.openSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike)
    this.setupTimeoutMs = options.setupTimeoutMs ?? REQUEST_TIMEOUT_MS
    this.heartbeatMs = options.heartbeatMs
  }

  async start(mode: SessionMode = "continuous"): Promise<void> {
    trace("provider.start.begin")
    const generation = ++this.generation
    this.stopping = false
    this.ready = false
    this.ended = true
    this.resumptionHandle = ""
    this.reconnectAttempted = false
    this.errorReported = false
    this.inputTranscript = ""
    this.outputTranscript = ""
    this.interruptionFinalized = false
    this.turnActive = false
    this.completeUserTurns = 0
    this.pendingEvents = []
    this.appendTail = Promise.resolve()
    this.persistenceFatal = false
    this.reflecting = false
    this.reflectionResolve = null
    this.stopPromise = null
    this.pendingToolCalls.clear()
    this.deliveredToolResultIds.clear()
    this.audioFramesSent = 0
    this.providerAudioChunks = 0
    this.mode = mode
    try {
      const response = await this.requestStart(mode)
      trace("provider.bootstrap.ready")
      this.token = response.ephemeral_token
      if (generation !== this.generation) {
        await this.endLease()
        throw new Error("Gemini start cancelled")
      }
      await this.connectSocket("")
      trace("provider.socket.ready")
      if (generation !== this.generation) throw new Error("Gemini start cancelled")
      this.heartbeatTimer = setInterval(
        () => void this.heartbeat(),
        this.heartbeatMs ?? Math.floor((response.lease_seconds * 1000) / 3),
      )
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  sendAudio(base64Pcm: string): void {
    if (!this.ready && !this.stopping) {
      // ponytail: drop audio during the single reconnect; add a bounded queue only if field tests show speech loss.
      return
    }
    if (!this.socket || this.socket.readyState !== WS_OPEN) throw new Error("Gemini socket is not ready")
    this.sendAudioToSocket(this.socket, base64Pcm)
  }

  sendActivity(audioChunks: readonly string[]): void {
    const socket = this.socket
    if (this.mode !== "manual") throw new Error("Manual activity requires Manual mode")
    if (audioChunks.length === 0) throw new Error("Manual recording is empty")
    if (!this.ready || this.stopping || !socket || socket.readyState !== WS_OPEN) {
      throw new Error("Gemini socket is not ready")
    }
    let started = false
    let ended = false
    try {
      socket.send(JSON.stringify({realtimeInput: {activityStart: {}}}))
      started = true
      this.turnActive = true
      for (const chunk of audioChunks) {
        if (socket.readyState !== WS_OPEN) throw new Error("socket closed during Manual activity")
        this.sendAudioToSocket(socket, chunk)
      }
      if (socket.readyState !== WS_OPEN) throw new Error("socket closed during Manual activity")
      socket.send(JSON.stringify({realtimeInput: {activityEnd: {}}}))
      ended = true
    } catch {
      if (started && !ended && socket.readyState === WS_OPEN) {
        try {
          socket.send(JSON.stringify({realtimeInput: {activityEnd: {}}}))
        } catch {
          /* provider state is already fatal */
        }
      }
      const error = new Error("Gemini manual activity send failed")
      this.reportError(error)
      throw error
    }
  }

  private sendAudioToSocket(socket: SocketLike, base64Pcm: string): void {
    socket.send(
      JSON.stringify({
        realtimeInput: {audio: {data: base64Pcm, mimeType: "audio/pcm;rate=16000"}},
      }),
    )
    this.audioFramesSent += 1
  }

  stop(graceful = false): Promise<void> {
    this.stopPromise ??= this.performStop(graceful)
    return this.stopPromise
  }

  private async performStop(graceful: boolean): Promise<void> {
    trace("provider.stop.begin", {graceful, turnActive: this.turnActive})
    try {
      const stoppedMidTurn = this.turnActive
      if (this.inputTranscript.trim() || this.outputTranscript.trim()) {
        this.finalizeInterruptedTurn()
        this.interruptionFinalized = false
      }
      if (graceful && !stoppedMidTurn && this.ready && this.completeUserTurns >= 2) {
        trace("provider.reflection.begin")
        const reflection = await this.requestReflection()
        trace("provider.reflection.end", {persisted: Boolean(reflection && reflection !== "NO_SUMMARY")})
        if (reflection && reflection !== "NO_SUMMARY") {
          this.enqueueEvent("sitting_summary", "assistant", reflection)
        }
      }
      this.stopping = true
      this.ready = false
      await this.appendTail
      trace("provider.transcript_queue.drained")
      if (!this.persistenceFatal) await this.flushPendingEvents()
      if (this.pendingEvents.length) {
        this.callbacks.onPersistenceError("Transcript sync failed; last turns were not saved")
      }
    } catch (error) {
      this.persistenceFatal = true
      this.callbacks.onPersistenceError("Transcript sync failed; last turns were not saved")
      this.reportError(error instanceof Error ? error : new Error(String(error)))
    } finally {
      this.generation += 1
      this.stopping = true
      this.ready = false
      this.clearHeartbeat()
      const socket = this.socket
      this.socket = null
      socket?.close()
      this.pendingToolCalls.clear()
      this.deliveredToolResultIds.clear()
      await this.endLease()
      trace("provider.stop.end")
    }
  }

  private async requestStart(mode: SessionMode): Promise<StartResponse> {
    let response: Response
    for (let attempt = 0; ; attempt += 1) {
      response = await this.request("/integration/mentra/session/start", {
        user_id: this.config.userId,
        soul_id: this.config.soulId,
        device_session_id: this.config.deviceSessionId,
        mode,
      })
      if (response.ok) break
      const errorBody = response.status === 409 ? await response.clone().json().catch(() => null) : null
      if (
        attempt === 0 &&
        errorBody?.detail?.code === "mentra_history_changed"
      ) {
        continue
      }
      throw new Error(`OpenAlma Start failed (${response.status})`)
    }
    const body = (await response.json()) as Partial<StartResponse>
    if (typeof body.session_id === "string" && body.session_id.trim()) {
      this.sessionId = body.session_id
      this.ended = false
    }
    const ws = body.websocket
    if (
      typeof body.session_id !== "string" ||
      !body.session_id.trim() ||
      !Number.isSafeInteger(body.next_transcript_sequence) ||
      Number(body.next_transcript_sequence) < 1 ||
      typeof body.ephemeral_token !== "string" ||
      !body.ephemeral_token ||
      !ws ||
      ws.api_version !== "v1alpha" ||
      ws.method !== "BidiGenerateContentConstrained" ||
      ws.input_audio_rate_hz !== 16000 ||
      ws.output_audio_rate_hz !== 24000 ||
      typeof body.lease_seconds !== "number" ||
      !Number.isFinite(body.lease_seconds) ||
      body.lease_seconds <= 0
    ) {
      throw new Error("OpenAlma Start returned an invalid session contract")
    }
    this.nextTranscriptSequence = Number(body.next_transcript_sequence)
    return body as StartResponse
  }

  private async connectSocket(handle: string): Promise<void> {
    const url =
      "wss://generativelanguage.googleapis.com/ws/" +
      "google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained" +
      `?access_token=${encodeURIComponent(this.token)}`
    const socket = this.openSocket(url)
    this.socket = socket

    await new Promise<void>((resolve, reject) => {
      let settled = false
      let ready = false
      const timeout = setTimeout(() => finish(new Error("Gemini setup timed out")), this.setupTimeoutMs)
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (error) reject(error)
        else resolve()
      }

      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({setup: {sessionResumption: handle ? {handle} : {}}}))
      })
      socket.addEventListener("message", (event) => {
        if (this.stopping || this.socket !== socket) return
        try {
          const message = this.parseMessage(event.data)
          if (message.setupComplete !== undefined) {
            ready = true
            this.ready = true
            this.flushToolResponses()
            trace("provider.setup_complete", {resumed: Boolean(handle)})
            finish()
          }
          this.handleMessage(message)
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error))
          if (this.reflecting) this.finishReflection(null)
          if (ready) this.reportError(normalized)
          else finish(normalized)
        }
      })
      socket.addEventListener("error", () => {
        if (this.stopping || this.socket !== socket) return
        const error = new Error(ready ? "Gemini socket failed" : "Gemini socket failed during setup")
        if (ready) socket.close()
        else finish(error)
      })
      socket.addEventListener("close", () => {
        if (!settled) finish(new Error("Gemini socket closed during setup"))
        if (ready && !this.stopping && this.socket === socket) void this.handleUnexpectedClose()
      })
    })
  }

  private parseMessage(data: unknown): Record<string, any> {
    if (data instanceof ArrayBuffer) data = new TextDecoder().decode(new Uint8Array(data))
    if (typeof data !== "string") throw new Error("Gemini returned a non-text message")
    const parsed = JSON.parse(data)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Gemini returned malformed JSON")
    }
    return parsed
  }

  private handleMessage(message: Record<string, any>): void {
    const update = message.sessionResumptionUpdate
    if (update?.resumable === true && typeof update.newHandle === "string" && update.newHandle.trim()) {
      this.resumptionHandle = update.newHandle
    }

    const hasToolCall = message.toolCall !== undefined
    if (hasToolCall) trace("provider.tool_call")
    if (message.serverContent !== undefined) {
      this.handleServerContent(message.serverContent, hasToolCall)
    }
    if (hasToolCall) this.handleToolCall(message.toolCall)
    if (message.toolCallCancellation !== undefined) {
      this.handleToolCancellation(message.toolCallCancellation)
    }
  }

  private handleServerContent(content: any, hasToolCall: boolean): void {
    if (!content || typeof content !== "object") throw new Error("Gemini returned malformed server content")
    const interrupted = content.interrupted === true
    const parts = content.modelTurn?.parts
    if (parts !== undefined && !Array.isArray(parts)) throw new Error("Gemini returned malformed model parts")
    if (content.modelTurn !== undefined || content.inputTranscription !== undefined || content.outputTranscription !== undefined) {
      this.turnActive = true
    }
    for (const part of interrupted ? [] : (parts ?? [])) {
      const inline = part?.inlineData
      if (inline === undefined) continue
      if (
        typeof inline?.data !== "string" ||
        inline.data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(inline.data) ||
        approxBase64ByteLength(inline.data) < 2 ||
        approxBase64ByteLength(inline.data) % 2 !== 0
      ) {
        throw new Error("Gemini returned malformed audio")
      }
      this.callbacks.onAudio(inline.data)
      this.providerAudioChunks += 1
    }

    const input = this.transcriptText(content.inputTranscription, "input")
    const output = this.transcriptText(content.outputTranscription, "output")
    if (input) trace("provider.input_transcription", {text: input})
    if (output) trace("provider.output_transcription", {text: output})
    if (this.reflecting) {
      if (input) throw new Error("Gemini returned input transcription during reflection")
      this.outputTranscript += output
      if (interrupted) {
        trace("provider.reflection.interrupted")
        this.callbacks.onInterrupted()
        this.finishReflection(null)
      } else if (content.turnComplete === true) {
        this.callbacks.onTurnComplete(true)
        this.finishReflection(this.outputTranscript.trim() || null)
      }
      return
    }

    this.inputTranscript += input
    this.outputTranscript += output
    if (interrupted) {
      trace("provider.interrupted", {
        audioChunks: this.providerAudioChunks,
        inputChars: this.inputTranscript.length,
        outputChars: this.outputTranscript.length,
      })
      this.finalizeInterruptedTurn(true)
      this.callbacks.onInterrupted()
    }
    if (content.turnComplete === true) {
      trace("provider.turn_complete", {
        hasToolCall,
        interrupted: this.interruptionFinalized,
        ...(this.interruptionFinalized ? {} : {
          audioChunks: this.providerAudioChunks,
          inputChars: this.inputTranscript.length,
          outputChars: this.outputTranscript.length,
        }),
      })
      this.providerAudioChunks = 0
      if (this.interruptionFinalized) {
        this.interruptionFinalized = false
      } else {
        this.finalizeCompleteTurn(hasToolCall)
      }
      this.turnActive = false
      this.callbacks.onTurnComplete(!hasToolCall)
    }
  }

  private transcriptText(value: unknown, label: string): string {
    if (value === undefined) return ""
    if (!value || typeof value !== "object" || typeof (value as {text?: unknown}).text !== "string") {
      throw new Error(`Gemini returned malformed ${label} transcription`)
    }
    return (value as {text: string}).text
  }

  private finalizeCompleteTurn(toolCallBoundary = false): void {
    const input = this.inputTranscript.trim()
    const output = this.outputTranscript.trim()
    this.clearTurn()
    if (!input && !output) throw new Error("Gemini completed a turn without transcription")
    const followsToolResult = !input && output && this.deliveredToolResultIds.size > 0
    if ((!input || !output) && !(input && toolCallBoundary) && !followsToolResult) {
      throw new Error("Gemini completed a turn without both transcriptions")
    }
    if (input) {
      this.enqueueEvent("transcript", "user", input, "complete")
      this.completeUserTurns += 1
    }
    if (output) this.enqueueEvent("transcript", "assistant", output, "complete")
    this.deliveredToolResultIds.clear()
    this.scheduleAppend()
  }

  private handleToolCall(value: unknown): void {
    if (this.stopping || this.reflecting) throw new Error("Gemini requested memory during teardown")
    if (!value || typeof value !== "object") throw new Error("Gemini returned malformed tool call")
    const calls = (value as {functionCalls?: unknown}).functionCalls
    if (!Array.isArray(calls) || !calls.length) {
      throw new Error("Gemini returned malformed tool call")
    }
    const parsed: Array<{id: string; query: string}> = []
    const ids = new Set<string>()
    for (const call of calls) {
      const id = typeof call?.id === "string" ? call.id.trim() : ""
      const name = typeof call?.name === "string" ? call.name : ""
      const args = call?.args
      const query = args && typeof args === "object" && !Array.isArray(args)
        ? (args as {query?: unknown}).query
        : undefined
      if (
        !id ||
        name !== "recall_memory" ||
        typeof query !== "string" ||
        !query.trim() ||
        Object.keys(args as object).some((key) => key !== "query") ||
        ids.has(id) ||
        this.pendingToolCalls.has(id)
      ) {
        throw new Error("Gemini returned malformed recall_memory call")
      }
      ids.add(id)
      parsed.push({id, query: query.trim()})
    }
    for (const {id, query} of parsed) {
      const pending: PendingToolCall = {
        generation: this.generation,
        sessionId: this.sessionId,
      }
      this.pendingToolCalls.set(id, pending)
      void this.runRecall(id, query, pending)
    }
  }

  private handleToolCancellation(value: unknown): void {
    if (!value || typeof value !== "object") throw new Error("Gemini returned malformed tool cancellation")
    const ids = (value as {ids?: unknown}).ids
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id.trim())) {
      throw new Error("Gemini returned malformed tool cancellation")
    }
    for (const id of ids) this.pendingToolCalls.delete(id)
  }

  private async runRecall(id: string, query: string, pending: PendingToolCall): Promise<void> {
    const startedAt = Date.now()
    trace("recall.begin", {id, query})
    let response: Response
    try {
      response = await this.request(
        `/integration/mentra/session/${this.sessionId}/recall`,
        {user_id: this.config.userId, soul_id: this.config.soulId, query},
        RECALL_TIMEOUT_MS,
      )
    } catch {
      trace("recall.network_failure", {id, elapsedMs: Date.now() - startedAt})
      this.completeRecall(id, pending, "Memory recall is temporarily unavailable.", true)
      return
    }
    if ([400, 401, 403, 404, 409, 422, 503].includes(response.status)) {
      trace("recall.fatal", {id, status: response.status, elapsedMs: Date.now() - startedAt})
      this.failRecall(id, pending, `OpenAlma memory recall failed (${response.status})`)
      return
    }
    if (!response.ok) {
      trace("recall.temporary_failure", {id, status: response.status, elapsedMs: Date.now() - startedAt})
      this.completeRecall(id, pending, "Memory recall is temporarily unavailable.", true)
      return
    }
    const body = await response.json().catch(() => null) as {context?: unknown; retrieve_ms?: unknown} | null
    if (
      !body ||
      typeof body.context !== "string" ||
      !body.context.trim() ||
      (body.retrieve_ms !== null && body.retrieve_ms !== undefined &&
        (typeof body.retrieve_ms !== "number" || !Number.isFinite(body.retrieve_ms)))
    ) {
      this.failRecall(id, pending, "OpenAlma memory recall returned an invalid response")
      return
    }
    this.completeRecall(id, pending, body.context.trim(), false)
    trace("recall.end", {id, elapsedMs: Date.now() - startedAt, context: body.context.trim()})
  }

  private completeRecall(id: string, pending: PendingToolCall, result: string, failed: boolean): void {
    if (this.pendingToolCalls.get(id) !== pending) return
    pending.response = result
    if (failed) this.callbacks.onPersistenceError("Memory recall unavailable; voice is continuing")
    this.flushToolResponses()
  }

  private failRecall(id: string, pending: PendingToolCall, message: string): void {
    if (this.pendingToolCalls.get(id) !== pending) return
    this.pendingToolCalls.delete(id)
    this.reportError(new Error(message))
  }

  private flushToolResponses(): void {
    for (const [id, pending] of this.pendingToolCalls) {
      if (!pending.response) continue
      if (
        pending.generation !== this.generation ||
        pending.sessionId !== this.sessionId ||
        this.stopping ||
        this.reflecting
      ) {
        this.pendingToolCalls.delete(id)
        continue
      }
      if (!this.ready || !this.socket || this.socket.readyState !== WS_OPEN) continue
      this.socket.send(JSON.stringify({
        toolResponse: {
          functionResponses: [{
            id,
            name: "recall_memory",
            response: {result: pending.response},
            scheduling: "SILENT",
          }],
        },
      }))
      this.deliveredToolResultIds.add(id)
      this.pendingToolCalls.delete(id)
    }
  }

  private finalizeInterruptedTurn(userComplete = false): void {
    const input = this.inputTranscript.trim()
    const output = this.outputTranscript.trim()
    this.clearTurn()
    if (input) this.enqueueEvent("transcript", "user", input, userComplete ? "complete" : "interrupted")
    if (output) this.enqueueEvent("transcript", "assistant", output, "interrupted")
    if (input && userComplete) this.completeUserTurns += 1
    this.interruptionFinalized = true
    if (input || output) this.scheduleAppend()
  }

  private clearTurn(): void {
    this.inputTranscript = ""
    this.outputTranscript = ""
  }

  private enqueueEvent(
    eventKind: TranscriptEvent["event_kind"],
    role: TranscriptEvent["role"],
    content: string,
    status?: TranscriptEvent["status"],
  ): void {
    const sequence = this.nextTranscriptSequence++
    this.pendingEvents.push({
      event_id: `${this.sessionId}:${sequence}`,
      sequence,
      event_kind: eventKind,
      role,
      content,
      ...(status ? {status} : {}),
    })
  }

  private scheduleAppend(): void {
    this.appendTail = this.appendTail.then(() => this.flushPendingEvents()).catch((error) => {
      this.persistenceFatal = true
      this.reportError(error instanceof Error ? error : new Error(String(error)))
    })
  }

  private async flushPendingEvents(): Promise<void> {
    while (this.pendingEvents.length && !this.persistenceFatal) {
      const batch = this.pendingEvents.slice(0, 16)
      let response: Response
      try {
        response = await this.request(`/integration/mentra/session/${this.sessionId}/transcripts/append`, {
          user_id: this.config.userId,
          soul_id: this.config.soulId,
          events: batch,
        })
      } catch {
        this.callbacks.onPersistenceError("Transcript sync failed; retrying")
        return
      }
      if (response.status >= 500) {
        this.callbacks.onPersistenceError("Transcript sync failed; retrying")
        return
      }
      if (!response.ok) throw new Error(`OpenAlma transcript append failed (${response.status})`)
      const result = (await response.json()) as {ack_sequence?: unknown}
      const ack = result.ack_sequence
      if (!Number.isSafeInteger(ack) || Number(ack) !== batch[batch.length - 1].sequence) {
        throw new Error("OpenAlma transcript append returned an invalid acknowledgement")
      }
      this.pendingEvents = this.pendingEvents.filter((event) => event.sequence > Number(ack))
    }
    if (!this.pendingEvents.length) this.callbacks.onPersistenceError(null)
  }

  private requestReflection(): Promise<string | null> {
    this.reflecting = true
    this.clearTurn()
    return new Promise((resolve) => {
      const timeout = setTimeout(() => this.finishReflection(null), REFLECTION_TIMEOUT_MS)
      this.reflectionResolve = (value) => {
        clearTimeout(timeout)
        resolve(value)
      }
      try {
        this.socket!.send(
          JSON.stringify({
            clientContent: {
              turns: [{role: "user", parts: [{text: SITTING_REFLECTION_PROMPT}]}],
              turnComplete: true,
            },
          }),
        )
      } catch {
        this.finishReflection(null)
      }
    })
  }

  private finishReflection(value: string | null): void {
    if (!this.reflecting) return
    this.reflecting = false
    this.turnActive = false
    this.clearTurn()
    const resolve = this.reflectionResolve
    this.reflectionResolve = null
    resolve?.(value)
  }

  private async handleUnexpectedClose(): Promise<void> {
    trace("provider.socket.closed", {resumable: Boolean(this.resumptionHandle)})
    this.socket = null
    this.ready = false
    if (this.reflecting) {
      this.finishReflection(null)
      return
    }
    if (this.inputTranscript.trim() || this.outputTranscript.trim()) {
      this.finalizeInterruptedTurn()
    } else {
      this.clearTurn()
    }
    this.interruptionFinalized = false
    this.turnActive = false
    if (this.resumptionHandle && !this.reconnectAttempted) {
      this.reconnectAttempted = true
      try {
        await this.connectSocket(this.resumptionHandle)
        return
      } catch (error) {
        this.reportError(error instanceof Error ? error : new Error(String(error)))
        return
      }
    }
    this.reportError(new Error("Gemini connection closed"))
  }

  private async heartbeat(): Promise<void> {
    trace("provider.heartbeat", {audioFramesSent: this.audioFramesSent})
    try {
      const response = await this.request(`/integration/mentra/session/${this.sessionId}/heartbeat`, {
        user_id: this.config.userId,
        soul_id: this.config.soulId,
      })
      if (!response.ok) throw new Error(`OpenAlma heartbeat failed (${response.status})`)
    } catch (error) {
      this.reportError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private async endLease(): Promise<void> {
    if (this.ended || !this.sessionId) return
    this.ended = true
    try {
      await this.request(`/integration/mentra/session/${this.sessionId}/end`, {
        user_id: this.config.userId,
        soul_id: this.config.soulId,
      })
    } catch {
      // End is idempotent and best-effort after local teardown.
    }
  }

  private request(path: string, body: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    return this.fetchFn(`${this.config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout))
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private reportError(error: Error): void {
    if (this.stopping || this.errorReported) return
    this.errorReported = true
    this.pendingToolCalls.clear()
    this.deliveredToolResultIds.clear()
    this.clearHeartbeat()
    this.callbacks.onError(error)
  }
}
