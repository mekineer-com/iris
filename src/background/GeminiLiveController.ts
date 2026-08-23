import {approxBase64ByteLength} from "./audioHelpers"
import type {OpenAlmaConfig} from "./openAlmaConfig"

type StartResponse = {
  session_id: string
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
  onError: (error: Error) => void
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

export class GeminiLiveController {
  private readonly fetchFn: typeof fetch
  private readonly openSocket: (url: string) => SocketLike
  private readonly setupTimeoutMs: number
  private readonly heartbeatMs?: number
  private socket: SocketLike | null = null
  private token = ""
  private sessionId = ""
  private resumptionHandle = ""
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private stopping = false
  private ended = true
  private reconnectAttempted = false
  private errorReported = false
  private inputTranscript = ""
  private outputTranscript = ""
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
    try {
      const response = await this.requestStart()
      this.token = response.ephemeral_token
      if (generation !== this.generation) throw new Error("Gemini start cancelled")
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

  async stop(): Promise<void> {
    this.generation += 1
    this.stopping = true
    this.ready = false
    this.clearHeartbeat()
    const socket = this.socket
    this.socket = null
    socket?.close()
    await this.endLease()
  }

  private async requestStart(): Promise<StartResponse> {
    const response = await this.request("/integration/mentra/session/start", {
      user_id: this.config.userId,
      soul_id: this.config.soulId,
      device_session_id: this.config.deviceSessionId,
      mode: "continuous",
    })
    if (!response.ok) throw new Error(`OpenAlma Start failed (${response.status})`)
    this.sessionId = this.config.deviceSessionId
    this.ended = false
    const body = (await response.json()) as Partial<StartResponse>
    const ws = body.websocket
    if (
      typeof body.session_id !== "string" ||
      body.session_id !== this.config.deviceSessionId ||
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
    if (update?.resumable === true && typeof update.handle === "string" && update.handle.trim()) {
      this.resumptionHandle = update.handle
    }

    const content = message.serverContent
    if (content === undefined) return
    if (!content || typeof content !== "object") throw new Error("Gemini returned malformed server content")
    const interrupted = content.interrupted === true
    if (interrupted) this.callbacks.onInterrupted()

    const parts = content.modelTurn?.parts
    if (parts !== undefined && !Array.isArray(parts)) throw new Error("Gemini returned malformed model parts")
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

    this.inputTranscript += this.transcriptText(content.inputTranscription, "input")
    this.outputTranscript += this.transcriptText(content.outputTranscription, "output")
    if (content.turnComplete === true) {
      this.callbacks.onTurnComplete()
      this.inputTranscript = ""
      this.outputTranscript = ""
    }
  }

  private transcriptText(value: unknown, label: string): string {
    if (value === undefined) return ""
    if (!value || typeof value !== "object" || typeof (value as {text?: unknown}).text !== "string") {
      throw new Error(`Gemini returned malformed ${label} transcription`)
    }
    return (value as {text: string}).text
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

  private request(path: string, body: Record<string, string>): Promise<Response> {
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
    void this.endLease()
    this.callbacks.onError(error)
  }
}
