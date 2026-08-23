import {approxBase64ByteLength} from "./audioHelpers"
import type {OpenAlmaConfig} from "./openAlmaConfig"

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
  onTurnComplete: () => void
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

  async start(): Promise<void> {
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
    try {
      const response = await this.requestStart()
      this.token = response.ephemeral_token
      if (generation !== this.generation) {
        await this.endLease()
        throw new Error("Gemini start cancelled")
      }
      await this.connectSocket("")
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
    this.socket.send(
      JSON.stringify({
        realtimeInput: {audio: {data: base64Pcm, mimeType: "audio/pcm;rate=16000"}},
      }),
    )
  }

  stop(graceful = false): Promise<void> {
    this.stopPromise ??= this.performStop(graceful)
    return this.stopPromise
  }

  private async performStop(graceful: boolean): Promise<void> {
    try {
      const stoppedMidTurn = this.turnActive
      if (this.inputTranscript.trim() || this.outputTranscript.trim()) {
        this.finalizeInterruptedTurn()
        this.interruptionFinalized = false
      }
      if (graceful && !stoppedMidTurn && this.ready && this.completeUserTurns >= 2) {
        const reflection = await this.requestReflection()
        if (reflection && reflection !== "NO_SUMMARY") {
          this.enqueueEvent("sitting_summary", "assistant", reflection)
        }
      }
      this.stopping = true
      this.ready = false
      await this.appendTail
      if (!this.persistenceFatal) await this.flushPendingEvents()
    } catch (error) {
      this.persistenceFatal = true
      this.reportError(error instanceof Error ? error : new Error(String(error)))
    } finally {
      this.generation += 1
      this.stopping = true
      this.ready = false
      this.clearHeartbeat()
      const socket = this.socket
      this.socket = null
      socket?.close()
      await this.endLease()
    }
  }

  private async requestStart(): Promise<StartResponse> {
    const response = await this.request("/integration/mentra/session/start", {
      user_id: this.config.userId,
      soul_id: this.config.soulId,
      device_session_id: this.config.deviceSessionId,
      mode: "continuous",
    })
    if (!response.ok) throw new Error(`OpenAlma Start failed (${response.status})`)
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
            finish()
          }
          this.handleMessage(message)
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error))
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

    const content = message.serverContent
    if (content === undefined) return
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
    }

    const input = this.transcriptText(content.inputTranscription, "input")
    const output = this.transcriptText(content.outputTranscription, "output")
    if (this.reflecting) {
      if (input) throw new Error("Gemini returned input transcription during reflection")
      this.outputTranscript += output
      if (interrupted) {
        this.callbacks.onInterrupted()
        this.finishReflection(null)
      } else if (content.turnComplete === true) {
        this.callbacks.onTurnComplete()
        this.finishReflection(this.outputTranscript.trim() || null)
      }
      return
    }

    if (input) {
      if (this.inputTranscript) throw new Error("Gemini returned multiple input transcription fields")
      this.inputTranscript = input
    }
    this.outputTranscript += output
    if (interrupted) {
      this.finalizeInterruptedTurn()
      this.callbacks.onInterrupted()
    }
    if (content.turnComplete === true) {
      if (this.interruptionFinalized) {
        this.interruptionFinalized = false
      } else {
        this.finalizeCompleteTurn()
      }
      this.turnActive = false
      this.callbacks.onTurnComplete()
    }
  }

  private transcriptText(value: unknown, label: string): string {
    if (value === undefined) return ""
    if (!value || typeof value !== "object" || typeof (value as {text?: unknown}).text !== "string") {
      throw new Error(`Gemini returned malformed ${label} transcription`)
    }
    return (value as {text: string}).text
  }

  private finalizeCompleteTurn(): void {
    const input = this.inputTranscript.trim()
    const output = this.outputTranscript.trim()
    this.clearTurn()
    if (!input || !output) throw new Error("Gemini completed a turn without both transcriptions")
    this.enqueueEvent("transcript", "user", input, "complete")
    this.enqueueEvent("transcript", "assistant", output, "complete")
    this.completeUserTurns += 1
    this.scheduleAppend()
  }

  private finalizeInterruptedTurn(): void {
    const input = this.inputTranscript.trim()
    const output = this.outputTranscript.trim()
    this.clearTurn()
    if (input) this.enqueueEvent("transcript", "user", input, "interrupted")
    if (output) this.enqueueEvent("transcript", "assistant", output, "interrupted")
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
    this.callbacks.onPersistenceError(null)
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
    this.socket = null
    this.ready = false
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

  private request(path: string, body: unknown): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
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
    this.clearHeartbeat()
    this.callbacks.onError(error)
  }
}
