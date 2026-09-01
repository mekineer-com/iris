import {describe, expect, test} from "bun:test"

import type {GeminiCallbacks} from "./GeminiLiveController"
import {GeminiLiveController} from "./GeminiLiveController"
import type {OpenAlmaConfig} from "./openAlmaConfig"
import {SessionController} from "./SessionController"

type Snapshot = {
  mode: string
  connection: string
  manualPhase: string
  microphoneEnabled: boolean
  cameraEnabled: boolean
  photoRetryPending: boolean
  lastError: string | null
  usageTotalTokens: number | null
  durationWarning: boolean
}

const CONFIG: OpenAlmaConfig = {
  baseUrl: "http://127.0.0.1:9999",
  bearer: "fictional",
  userId: "Test User",
  soulId: "Test Soul",
  deviceSessionId: "test-phone",
}

function silentPcm(): string {
  return Buffer.alloc(8).toString("base64")
}

function testPcm(value: number): string {
  return Buffer.alloc(8, value).toString("base64")
}

class FakeLive {
  starts = 0
  stops = 0
  stopArgs: boolean[] = []
  sent: string[] = []
  startModes: string[] = []
  activities: string[][] = []
  images: unknown[] = []
  imageRetries = 0
  imageDiscards = 0
  activityError: Error | null = null
  startGate: Promise<void> | null = null
  stopGate: Promise<void> | null = null
  audioOnStop = false
  persistenceOnStop: string | null = null

  constructor(readonly callbacks: GeminiCallbacks) {}

  async start(mode = "continuous"): Promise<void> {
    this.starts += 1
    this.startModes.push(mode)
    if (this.startGate) await this.startGate
  }

  sendAudio(data: string): void {
    this.sent.push(data)
  }

  sendActivity(chunks: readonly string[]): void {
    if (this.activityError) throw this.activityError
    this.activities.push([...chunks])
  }

  async sendImage(image: unknown): Promise<void> {
    this.images.push(image)
  }

  async retryImage(): Promise<void> {
    this.imageRetries += 1
  }

  async discardImage(): Promise<void> {
    this.imageDiscards += 1
  }

  async stop(graceful = false): Promise<void> {
    this.stops += 1
    this.stopArgs.push(graceful)
    if (graceful && this.audioOnStop) this.callbacks.onAudio(silentPcm())
    if (this.persistenceOnStop) this.callbacks.onPersistenceError(this.persistenceOnStop)
    if (this.stopGate) await this.stopGate
  }

  audio(data = silentPcm()): void {
    this.callbacks.onAudio(data)
  }

  turnComplete(finalResponse = true): void {
    this.callbacks.onTurnComplete(finalResponse)
  }

  interrupted(): void {
    this.callbacks.onInterrupted()
  }

  reconnecting(value: boolean): void {
    this.callbacks.onReconnecting(value)
  }

  usage(totalTokens: number): void {
    this.callbacks.onUsage(totalTokens)
  }

  durationWarning(): void {
    this.callbacks.onDurationWarning()
  }

  persistence(message: string | null): void {
    this.callbacks.onPersistenceError(message)
  }

  photoRetry(pending: boolean): void {
    this.callbacks.onPhotoRetryChange(pending)
  }

  fail(message: string): void {
    this.callbacks.onError(new Error(message))
  }
}

class FakeSession {
  micHandler: ((chunk: {data: string; sampleRate?: number; format?: string}) => void) | null = null
  micSubs = 0
  micStops = 0
  speakerStops = 0
  plays: Array<{audioUrl: string; stopOtherAudio?: boolean}> = []
  streams: Array<{
    opts: {sampleRate: number; stopOtherAudio?: boolean}
    writes: unknown[]
    aborted: boolean
    closed: boolean
  }> = []
  handlers: Record<string, (payload: unknown) => unknown> = {}
  onOpenCb: (() => void) | null = null
  snapshots: Snapshot[] = []
  createGate: Promise<void> | null = null
  closeGate: Promise<void> | null = null
  abortGate: Promise<void> | null = null
  playGate: Promise<void> | null = null
  createErrorOnce = false
  stored = new Map<string, string>()

  storage = {
    get: async (key: string) => this.stored.get(key) ?? null,
    set: async (key: string, value: string) => {
      this.stored.set(key, value)
    },
    delete: async (key: string) => {
      this.stored.delete(key)
    },
  }

  ui = {
    send: (channel: string, payload: Snapshot) => {
      if (channel === "openalma:update") this.snapshots.push(payload)
    },
    onOpen: (cb: () => void) => {
      this.onOpenCb = cb
      return () => {
        this.onOpenCb = null
      }
    },
    handle: (channel: string, handler: (payload: unknown) => unknown) => {
      this.handlers[channel] = handler
      return () => delete this.handlers[channel]
    },
  }

  mic = {
    onAudioChunk: (handler: (chunk: {data: string; sampleRate?: number; format?: string}) => void) => {
      this.micSubs += 1
      this.micHandler = handler
      return () => {
        this.micHandler = null
      }
    },
    stop: () => {
      this.micStops += 1
    },
  }

  speaker = {
    stop: () => {
      this.speakerStops += 1
    },
    play: async (options: {audioUrl: string; stopOtherAudio?: boolean}) => {
      this.plays.push(options)
      if (this.playGate) await this.playGate
    },
    createStream: async (opts: {sampleRate: number; stopOtherAudio?: boolean}) => {
      if (this.createErrorOnce) {
        this.createErrorOnce = false
        throw new Error("speaker open failed")
      }
      if (this.createGate) {
        const gate = this.createGate
        this.createGate = null
        await gate
      }
      const rec = {opts, writes: [] as unknown[], aborted: false, closed: false}
      this.streams.push(rec)
      return {
        write: async (chunk: unknown) => {
          rec.writes.push(chunk)
          return {bufferedMs: 0}
        },
        writeBase64: async (chunk: string) => {
          rec.writes.push(chunk)
          return {bufferedMs: 0}
        },
        close: async () => {
          rec.closed = true
          if (this.closeGate) await this.closeGate
          return {}
        },
        abort: async () => {
          rec.aborted = true
          if (this.abortGate) await this.abortGate
        },
      }
    },
  }
}

function setup(
  options: {
    watchdogMs?: number
    earconTimeoutMs?: number
    responseWatchdogMs?: number
    startGate?: Promise<void>
    stored?: Record<string, string>
  } = {},
) {
  const session = new FakeSession()
  for (const [key, value] of Object.entries(options.stored ?? {})) session.stored.set(key, value)
  let live!: FakeLive
  const controller = new SessionController(session as never, {
    watchdogMs: options.watchdogMs ?? 5000,
    earconTimeoutMs: options.earconTimeoutMs,
    responseWatchdogMs: options.responseWatchdogMs,
    config: CONFIG,
    createLiveController: (_config, callbacks) => {
      live = new FakeLive(callbacks)
      live.startGate = options.startGate ?? null
      return live as unknown as GeminiLiveController
    },
  })
  controller.start()
  return {
    session,
    controller,
    get live() {
      return live
    },
  }
}

function lastSnapshot(session: FakeSession): Snapshot | undefined {
  return session.snapshots.at(-1)
}

describe("SessionController", () => {
  test("routes images only while a sitting is active", async () => {
    const harness = setup()
    await expect(harness.session.handlers["openalma:image"]({})).rejects.toThrow("Start Iris")
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    const image = {imageId: "image-1", mimeType: "image/png", data: "AQID"}
    await harness.session.handlers["openalma:image"](image)
    expect(harness.live.images).toEqual([image])
    await harness.session.handlers["openalma:pending-image"]({action: "retry"})
    await harness.session.handlers["openalma:pending-image"]({action: "discard"})
    expect([harness.live.imageRetries, harness.live.imageDiscards]).toEqual([1, 1])
    await harness.session.handlers["openalma:stop"]({})
  })

  test("projects provider rollover as reconnecting with Stop ownership", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    harness.live.reconnecting(true)
    expect(lastSnapshot(harness.session)?.connection).toBe("reconnecting")
    harness.live.reconnecting(false)
    expect(lastSnapshot(harness.session)?.connection).toBe("listening")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.session.plays.at(-1)?.audioUrl).toEndWith("/earcons/listen-start.wav")
    await harness.session.handlers["openalma:stop"]({})
  })

  test("starts Gemini before mic and stops both", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    expect(harness.live.starts).toBe(1)
    expect(harness.session.micSubs).toBe(1)
    expect(harness.session.plays[0]).toEqual({
      audioUrl: "http://127.0.0.1:9999/integration/mentra/earcons/listen-start.wav",
      stopOtherAudio: true,
    })
    await harness.session.handlers["openalma:stop"]({})
    expect(harness.live.stops).toBe(1)
    expect(harness.live.stopArgs).toEqual([true])
    expect(harness.session.micHandler).toBeNull()
    expect(lastSnapshot(harness.session)?.connection).toBe("idle")
  })

  test("keeps Gemini speech that arrives during the start earcon", async () => {
    const harness = setup()
    let release!: () => void
    harness.session.playGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const start = harness.session.handlers["openalma:start"]({mode: "continuous"})
    while (harness.session.plays.length === 0) await new Promise((resolve) => setTimeout(resolve, 0))

    harness.live.audio()
    harness.live.turnComplete()
    release()
    await start
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(harness.session.streams[0]?.writes).toEqual([silentPcm()])
    expect(harness.session.streams[0]?.closed).toBe(true)
    expect(lastSnapshot(harness.session)?.connection).toBe("listening")
  })

  test("a hung start earcon is stopped and does not block listening", async () => {
    const harness = setup({earconTimeoutMs: 5})
    harness.session.playGate = new Promise<void>(() => {})

    await harness.session.handlers["openalma:start"]({mode: "continuous"})

    expect(harness.session.speakerStops).toBe(1)
    expect(lastSnapshot(harness.session)?.connection).toBe("listening")
    expect(lastSnapshot(harness.session)?.lastError).toBe("Audio cue unavailable; voice is still active")
  })

  test("a stale start earcon cannot stop its replacement sitting", async () => {
    const harness = setup({earconTimeoutMs: 5})
    harness.session.playGate = new Promise<void>(() => {})
    const staleStart = harness.session.handlers["openalma:start"]({mode: "continuous"})
    while (harness.session.plays.length === 0) await new Promise((resolve) => setTimeout(resolve, 0))
    const staleLive = harness.live
    harness.session.playGate = null

    await harness.session.handlers["openalma:stop"]({})
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    const replacement = harness.live
    await staleStart

    expect(staleLive.stops).toBe(1)
    expect(replacement.stops).toBe(0)
    expect(harness.session.speakerStops).toBe(0)
    expect(lastSnapshot(harness.session)?.connection).toBe("listening")
  })

  test("normalizes mic PCM and drains Gemini speech", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    harness.session.micHandler?.({data: silentPcm(), format: "pcm_s16le", sampleRate: 16000})
    expect(harness.live.sent).toEqual([silentPcm()])

    harness.live.audio()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lastSnapshot(harness.session)?.connection).toBe("speaking")
    expect(harness.session.streams[0]?.opts.sampleRate).toBe(24000)
    expect(harness.session.streams[0]?.writes).toEqual([silentPcm()])
    harness.session.micHandler?.({data: silentPcm(), format: "pcm_s16le", sampleRate: 16000})
    expect(harness.live.sent).toEqual([silentPcm()])
    harness.live.turnComplete()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.session.streams[0]?.closed).toBe(true)
    expect(lastSnapshot(harness.session)?.connection).toBe("listening")
    harness.session.micHandler?.({data: silentPcm(), format: "pcm_s16le", sampleRate: 16000})
    expect(harness.live.sent).toEqual([silentPcm(), silentPcm()])
  })

  test("turn completion waits for audio dispatched in the same tick", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    harness.live.audio()
    await new Promise((resolve) => setTimeout(resolve, 0))
    harness.live.audio()
    harness.live.turnComplete()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.session.streams[0]?.writes).toEqual([silentPcm(), silentPcm()])
    expect(harness.session.streams[0]?.closed).toBe(true)
  })

  test("interruption aborts stale speaker creation", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    let release!: () => void
    harness.session.createGate = new Promise<void>((resolve) => {
      release = resolve
    })
    harness.live.audio()
    await Promise.resolve()
    harness.live.interrupted()
    await Promise.resolve()
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.session.streams.at(-1)?.aborted).toBe(true)
    expect(lastSnapshot(harness.session)?.connection).toBe("listening")
  })

  test("stale stream opening cannot erase a newer opening", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    let releaseOld!: () => void
    harness.session.createGate = new Promise<void>((resolve) => {
      releaseOld = resolve
    })
    harness.live.audio()
    await Promise.resolve()
    harness.live.interrupted()
    await Promise.resolve()

    let releaseNew!: () => void
    harness.session.createGate = new Promise<void>((resolve) => {
      releaseNew = resolve
    })
    harness.live.audio()
    await Promise.resolve()
    releaseOld()
    await new Promise((resolve) => setTimeout(resolve, 0))
    harness.live.audio()
    await Promise.resolve()
    expect(harness.session.streams).toHaveLength(1)
    releaseNew()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.session.streams).toHaveLength(2)
  })

  test("interruption stops and aborts an active speaker stream", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    harness.live.audio()
    await new Promise((resolve) => setTimeout(resolve, 0))
    harness.live.interrupted()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.session.streams[0]?.aborted).toBe(true)
    expect(harness.session.speakerStops).toBe(1)
    expect(lastSnapshot(harness.session)?.connection).toBe("listening")
  })

  test("interruption uses native Stop while turn completion drains", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    harness.live.audio()
    await new Promise((resolve) => setTimeout(resolve, 0))
    let release!: () => void
    harness.session.closeGate = new Promise<void>((resolve) => {
      release = resolve
    })
    harness.live.turnComplete()
    await Promise.resolve()
    harness.live.interrupted()
    await Promise.resolve()
    expect(harness.session.speakerStops).toBe(1)
    release()
  })

  test("stale Gemini setup cannot stop its replacement sitting", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const options: {startGate?: Promise<void>} = {startGate: gate}
    const harness = setup(options)
    const staleStart = harness.session.handlers["openalma:start"]({mode: "continuous"})
    await Promise.resolve()
    await harness.session.handlers["openalma:stop"]({})
    const staleLive = harness.live
    options.startGate = undefined
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    const replacement = harness.live
    release()
    await staleStart
    expect(staleLive.stops).toBe(1)
    expect(replacement.stops).toBe(0)
    expect(lastSnapshot(harness.session)?.connection).toBe("listening")
  })

  test("stop during Gemini setup never subscribes mic", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const harness = setup({startGate: gate})
    const start = harness.session.handlers["openalma:start"]({mode: "continuous"})
    await Promise.resolve()

    await harness.session.handlers["openalma:stop"]({})
    release()
    await start

    expect(harness.session.micSubs).toBe(0)
    expect(lastSnapshot(harness.session)?.connection).toBe("idle")
  })

  test("watchdog failure plays disconnected once and stops Gemini", async () => {
    const harness = setup({watchdogMs: 15})
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(lastSnapshot(harness.session)?.connection).toBe("error")
    expect(harness.live.stops).toBe(1)
    expect(harness.session.plays).toHaveLength(2)
  })

  test("selects Manual while idle and rejects active mode changes", async () => {
    const harness = setup()
    expect(harness.session.handlers["openalma:set-mode"]({mode: "manual"})).toEqual({ok: true})
    await harness.session.handlers["openalma:start"]({mode: "manual"})
    await harness.session.handlers["openalma:start"]({mode: "manual"})
    expect(harness.live.starts).toBe(1)
    expect(harness.live.startModes).toEqual(["manual"])
    expect(() => harness.session.handlers["openalma:set-mode"]({mode: "continuous"})).toThrow(
      "Stop before changing speech mode",
    )
  })

  test("UI registration and provider failure remain observable", async () => {
    const harness = setup()
    harness.session.onOpenCb?.()
    expect(harness.session.snapshots[0]).toEqual({
      mode: "continuous",
      connection: "idle",
      manualPhase: "idle",
      microphoneEnabled: true,
      cameraEnabled: true,
      photoRetryPending: false,
      lastError: null,
      usageTotalTokens: null,
      durationWarning: false,
    })
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    harness.live.persistenceOnStop = "Transcript sync failed; pending turns remain saved on this device"
    harness.live.fail("provider failed")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lastSnapshot(harness.session)?.connection).toBe("error")
    expect(lastSnapshot(harness.session)?.lastError).toBe("provider failed")
  })

  test("temporary transcript failure is visible without stopping voice", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    harness.live.persistence("Memory recall unavailable; voice is continuing")
    expect(lastSnapshot(harness.session)).toMatchObject({
      connection: "listening",
      lastError: "Memory recall unavailable; voice is continuing",
    })
    harness.live.photoRetry(true)
    expect(lastSnapshot(harness.session)?.photoRetryPending).toBe(true)
    harness.live.persistence(null)
    expect(lastSnapshot(harness.session)).toMatchObject({connection: "listening", lastError: null})
    await harness.session.handlers["openalma:stop"]({})
  })

  test("persists independent microphone and camera controls during a sitting", async () => {
    const harness = setup({
      stored: {
        "openalma.microphone-enabled": "0",
        "openalma.camera-enabled": "0",
      },
    })
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    expect(harness.session.micSubs).toBe(0)
    await expect(harness.session.handlers["openalma:image"]({})).rejects.toThrow("Camera is disabled")

    await harness.session.handlers["openalma:set-capabilities"]({microphoneEnabled: true})
    harness.session.micHandler?.({data: silentPcm(), format: "pcm_s16le", sampleRate: 16000})
    expect(harness.live.sent).toEqual([silentPcm()])
    await harness.session.handlers["openalma:set-capabilities"]({microphoneEnabled: false})
    expect(harness.session.micHandler).toBeNull()

    await harness.session.handlers["openalma:set-capabilities"]({cameraEnabled: true})
    const image = {imageId: "image-1", mimeType: "image/png", data: "AQID"}
    await harness.session.handlers["openalma:image"](image)
    expect(harness.live.images).toEqual([image])
    expect(lastSnapshot(harness.session)).toMatchObject({
      microphoneEnabled: false,
      cameraEnabled: true,
    })
  })

  test("Manual records, reviews, redoes, and sends only the replacement", async () => {
    const harness = setup({watchdogMs: 15})
    await harness.session.handlers["openalma:start"]({mode: "manual"})
    harness.session.micHandler?.({data: testPcm(1), format: "pcm_s16le", sampleRate: 16000})
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(lastSnapshot(harness.session)).toMatchObject({connection: "listening", manualPhase: "idle"})

    harness.session.handlers["openalma:manual-action"]({action: "talk"})
    expect(() => harness.session.handlers["openalma:manual-action"]({action: "done"})).toThrow(
      "No audio was recorded",
    )
    harness.session.micHandler?.({data: testPcm(1), format: "pcm_s16le", sampleRate: 16000})
    harness.session.handlers["openalma:manual-action"]({action: "done"})
    expect(harness.live.activities).toEqual([])

    harness.session.handlers["openalma:manual-action"]({action: "redo"})
    harness.session.micHandler?.({data: testPcm(2), format: "pcm_s16le", sampleRate: 16000})
    harness.session.handlers["openalma:manual-action"]({action: "done"})
    harness.session.handlers["openalma:manual-action"]({action: "send"})
    expect(harness.live.activities).toEqual([[testPcm(2)]])
    expect(lastSnapshot(harness.session)?.manualPhase).toBe("submitted")

    harness.live.turnComplete()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lastSnapshot(harness.session)).toMatchObject({connection: "listening", manualPhase: "idle"})
  })

  test("Manual keeps a Review draft when the provider is not ready", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "manual"})
    harness.session.handlers["openalma:manual-action"]({action: "talk"})
    harness.session.micHandler?.({data: testPcm(1), format: "pcm_s16le", sampleRate: 16000})
    harness.session.handlers["openalma:manual-action"]({action: "done"})
    harness.live.activityError = new Error("Gemini socket is not ready")

    expect(() => harness.session.handlers["openalma:manual-action"]({action: "send"})).toThrow(
      "Gemini socket is not ready",
    )
    expect(lastSnapshot(harness.session)?.manualPhase).toBe("review")
    harness.live.activityError = null
    harness.session.handlers["openalma:manual-action"]({action: "send"})
    expect(harness.live.activities).toEqual([[testPcm(1)]])
  })

  test("Stop discards an unsent Manual draft", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "manual"})
    harness.session.handlers["openalma:manual-action"]({action: "talk"})
    harness.session.micHandler?.({data: testPcm(1), format: "pcm_s16le", sampleRate: 16000})
    harness.session.handlers["openalma:manual-action"]({action: "done"})

    await harness.session.handlers["openalma:stop"]({})
    await harness.session.handlers["openalma:start"]({mode: "manual"})
    expect(lastSnapshot(harness.session)?.manualPhase).toBe("idle")
    harness.session.handlers["openalma:manual-action"]({action: "talk"})
    expect(() => harness.session.handlers["openalma:manual-action"]({action: "done"})).toThrow(
      "No audio was recorded",
    )
    expect(harness.live.activities).toEqual([])
  })

  test("Stop after Manual Send cancels the submitted response watchdog", async () => {
    const harness = setup({responseWatchdogMs: 10})
    await harness.session.handlers["openalma:start"]({mode: "manual"})
    harness.session.handlers["openalma:manual-action"]({action: "talk"})
    harness.session.micHandler?.({data: testPcm(1), format: "pcm_s16le", sampleRate: 16000})
    harness.session.handlers["openalma:manual-action"]({action: "done"})
    harness.session.handlers["openalma:manual-action"]({action: "send"})

    await harness.session.handlers["openalma:stop"]({})
    expect(harness.live.stops).toBe(1)
    expect(lastSnapshot(harness.session)).toMatchObject({
      connection: "idle",
      manualPhase: "idle",
      lastError: null,
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(lastSnapshot(harness.session)).toMatchObject({connection: "idle", lastError: null})
  })

  test("first Siri audio cancels the Manual no-response watchdog", async () => {
    const harness = setup({responseWatchdogMs: 10})
    await harness.session.handlers["openalma:start"]({mode: "manual"})
    harness.session.handlers["openalma:manual-action"]({action: "talk"})
    harness.session.micHandler?.({data: testPcm(1), format: "pcm_s16le", sampleRate: 16000})
    harness.session.handlers["openalma:manual-action"]({action: "done"})
    harness.session.handlers["openalma:manual-action"]({action: "send"})
    harness.live.audio()

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(lastSnapshot(harness.session)).toMatchObject({
      connection: "speaking",
      manualPhase: "submitted",
      lastError: null,
    })
    harness.live.turnComplete()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lastSnapshot(harness.session)).toMatchObject({connection: "listening", manualPhase: "idle"})
  })

  test("Manual recording uses a 120-second PCM byte bound and clears its warning on Send", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "manual"})
    harness.session.handlers["openalma:manual-action"]({action: "talk"})
    harness.session.micHandler?.({
      data: Buffer.alloc(16000 * 2 * 120).toString("base64"),
      format: "pcm_s16le",
      sampleRate: 16000,
    })
    expect(lastSnapshot(harness.session)).toMatchObject({manualPhase: "recording", lastError: null})

    harness.session.micHandler?.({data: testPcm(1), format: "pcm_s16le", sampleRate: 16000})
    expect(lastSnapshot(harness.session)).toMatchObject({
      manualPhase: "review",
      lastError: "Manual recording reached 120-second limit",
    })
    harness.live.persistence(null)
    expect(lastSnapshot(harness.session)).toMatchObject({
      manualPhase: "review",
      lastError: "Manual recording reached 120-second limit",
    })
    harness.session.handlers["openalma:manual-action"]({action: "send"})
    expect(lastSnapshot(harness.session)).toMatchObject({manualPhase: "submitted", lastError: null})
  })

  test("tool boundary and interrupted abort cannot release Manual early", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "manual"})
    harness.session.handlers["openalma:manual-action"]({action: "talk"})
    harness.session.micHandler?.({data: testPcm(1), format: "pcm_s16le", sampleRate: 16000})
    harness.session.handlers["openalma:manual-action"]({action: "done"})
    harness.session.handlers["openalma:manual-action"]({action: "send"})

    harness.live.turnComplete(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lastSnapshot(harness.session)?.manualPhase).toBe("submitted")

    harness.live.audio()
    await new Promise((resolve) => setTimeout(resolve, 0))
    let release!: () => void
    harness.session.abortGate = new Promise<void>((resolve) => {
      release = resolve
    })
    harness.live.interrupted()
    harness.live.turnComplete()
    await Promise.resolve()
    expect(lastSnapshot(harness.session)?.manualPhase).toBe("submitted")
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lastSnapshot(harness.session)?.manualPhase).toBe("idle")
  })

  test("Manual interruption waits for a pending native stream to abort", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "manual"})
    harness.session.handlers["openalma:manual-action"]({action: "talk"})
    harness.session.micHandler?.({data: testPcm(1), format: "pcm_s16le", sampleRate: 16000})
    harness.session.handlers["openalma:manual-action"]({action: "done"})
    harness.session.handlers["openalma:manual-action"]({action: "send"})

    let release!: () => void
    harness.session.createGate = new Promise<void>((resolve) => {
      release = resolve
    })
    harness.live.audio()
    await Promise.resolve()
    harness.live.interrupted()
    await Promise.resolve()
    expect(lastSnapshot(harness.session)?.manualPhase).toBe("submitted")

    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.session.streams.at(-1)?.aborted).toBe(true)
    expect(lastSnapshot(harness.session)?.manualPhase).toBe("idle")
  })

  test("rejects unknown Manual actions without sending", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "manual"})
    harness.session.handlers["openalma:manual-action"]({action: "talk"})
    harness.session.micHandler?.({data: testPcm(1), format: "pcm_s16le", sampleRate: 16000})
    harness.session.handlers["openalma:manual-action"]({action: "done"})

    expect(() => harness.session.handlers["openalma:manual-action"]({action: "invalid"})).toThrow(
      "Unknown Manual action",
    )
    expect(harness.live.activities).toEqual([])
    expect(lastSnapshot(harness.session)?.manualPhase).toBe("review")
  })

  test("Manual response timeout fails the sitting", async () => {
    const harness = setup({responseWatchdogMs: 10})
    await harness.session.handlers["openalma:start"]({mode: "manual"})
    harness.session.handlers["openalma:manual-action"]({action: "talk"})
    harness.session.micHandler?.({data: testPcm(1), format: "pcm_s16le", sampleRate: 16000})
    harness.session.handlers["openalma:manual-action"]({action: "done"})
    harness.session.handlers["openalma:manual-action"]({action: "send"})

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(lastSnapshot(harness.session)).toMatchObject({
      connection: "error",
      manualPhase: "idle",
      lastError: "Gemini did not answer the Manual recording",
    })
  })

  test("Stop cancels Manual timeout before a pending speaker close", async () => {
    const harness = setup({responseWatchdogMs: 10})
    await harness.session.handlers["openalma:start"]({mode: "manual"})
    harness.session.handlers["openalma:manual-action"]({action: "talk"})
    harness.session.micHandler?.({data: testPcm(1), format: "pcm_s16le", sampleRate: 16000})
    harness.session.handlers["openalma:manual-action"]({action: "done"})
    harness.session.handlers["openalma:manual-action"]({action: "send"})
    harness.live.audio()
    await new Promise((resolve) => setTimeout(resolve, 0))
    harness.session.closeGate = new Promise<void>(() => {})
    harness.live.turnComplete()

    const stop = harness.session.handlers["openalma:stop"]({})
    await Promise.race([
      stop,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Stop deadlocked")), 100)),
    ])
    expect(lastSnapshot(harness.session)).toMatchObject({
      connection: "idle",
      lastError: null,
    })

    harness.session.closeGate = null
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    harness.live.audio()
    await new Promise((resolve) => setTimeout(resolve, 0))
    harness.live.turnComplete()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.session.streams.at(-1)?.closed).toBe(true)
    expect(lastSnapshot(harness.session)?.connection).toBe("listening")
  })

  test("Stop during fatal teardown awaits the same owner", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    let release!: () => void
    harness.live.stopGate = new Promise<void>((resolve) => {
      release = resolve
    })
    harness.live.fail("provider failed")
    await Promise.resolve()
    let stopped = false
    const stop = Promise.resolve(harness.session.handlers["openalma:stop"]({})).then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(harness.live.stops).toBe(1)
    release()
    await stop
    expect(harness.live.stops).toBe(1)
    expect(lastSnapshot(harness.session)).toMatchObject({connection: "idle", lastError: null})
  })

  test("Stop during a blocked fatal teardown cannot request reflection", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    harness.live.audio()
    await new Promise((resolve) => setTimeout(resolve, 0))
    let release!: () => void
    harness.session.abortGate = new Promise<void>((resolve) => {
      release = resolve
    })
    harness.live.persistenceOnStop = "Transcript sync failed; pending turns remain saved on this device"

    harness.live.fail("provider failed")
    await Promise.resolve()
    const stop = harness.session.handlers["openalma:stop"]({})
    release()
    await stop

    expect(harness.live.stopArgs).toEqual([false])
    expect(lastSnapshot(harness.session)).toMatchObject({
      connection: "idle",
      lastError: "Transcript sync failed; pending turns remain saved on this device",
    })
  })

  test("graceful teardown closes reflection audio without turnComplete", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    harness.live.audioOnStop = true
    await harness.session.handlers["openalma:stop"]({})
    expect(harness.session.streams[0]?.writes).toEqual([silentPcm()])
    expect(harness.session.streams[0]?.closed).toBe(true)
    expect(lastSnapshot(harness.session)?.connection).toBe("idle")
  })

  test("reflection speaker-open failure cannot strand teardown", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    harness.session.createErrorOnce = true
    harness.live.audioOnStop = true
    await harness.session.handlers["openalma:stop"]({})
    expect(harness.live.stops).toBe(1)
    expect(lastSnapshot(harness.session)).toMatchObject({connection: "idle", lastError: null})
  })

  test("graceful Stop preserves a final local-backup warning", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    harness.live.persistenceOnStop = "Transcript sync failed; pending turns remain saved on this device"
    await harness.session.handlers["openalma:stop"]({})
    expect(lastSnapshot(harness.session)).toMatchObject({
      connection: "idle",
      lastError: "Transcript sync failed; pending turns remain saved on this device",
    })
  })
})
