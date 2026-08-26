import {describe, expect, test} from "bun:test"

import type {GeminiCallbacks} from "./GeminiLiveController"
import {GeminiLiveController} from "./GeminiLiveController"
import type {OpenAlmaConfig} from "./openAlmaConfig"
import {SessionController} from "./SessionController"

type Snapshot = {mode: string; connection: string; lastError: string | null}

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

class FakeLive {
  starts = 0
  stops = 0
  stopArgs: boolean[] = []
  sent: string[] = []
  startGate: Promise<void> | null = null
  stopGate: Promise<void> | null = null
  audioOnStop = false
  persistenceOnStop: string | null = null

  constructor(readonly callbacks: GeminiCallbacks) {}

  async start(): Promise<void> {
    this.starts += 1
    if (this.startGate) await this.startGate
  }

  sendAudio(data: string): void {
    this.sent.push(data)
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

  turnComplete(): void {
    this.callbacks.onTurnComplete()
  }

  interrupted(): void {
    this.callbacks.onInterrupted()
  }

  persistence(message: string | null): void {
    this.callbacks.onPersistenceError(message)
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

function setup(options: {watchdogMs?: number; earconTimeoutMs?: number; startGate?: Promise<void>} = {}) {
  const session = new FakeSession()
  let live!: FakeLive
  const controller = new SessionController(session as never, {
    watchdogMs: options.watchdogMs ?? 5000,
    earconTimeoutMs: options.earconTimeoutMs,
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
    await Promise.resolve()
    await Promise.resolve()
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

  test("watchdog failure plays disconnected once and stops Gemini", async () => {
    const harness = setup({watchdogMs: 15})
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(lastSnapshot(harness.session)?.connection).toBe("error")
    expect(harness.live.stops).toBe(1)
    expect(harness.session.plays).toHaveLength(2)
  })

  test("duplicate Start is a no-op and Manual fails visibly", async () => {
    const harness = setup()
    expect(() => harness.session.handlers["openalma:set-mode"]({mode: "manual"})).toThrow(
      "Manual mode is available in Slice 7",
    )
    await expect(harness.session.handlers["openalma:start"]({mode: "manual"})).rejects.toThrow(
      "Manual mode is available in Slice 7",
    )
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    expect(harness.live.starts).toBe(1)
  })

  test("UI registration and provider failure remain observable", async () => {
    const harness = setup()
    harness.session.onOpenCb?.()
    expect(harness.session.snapshots[0]).toEqual({mode: "continuous", connection: "idle", lastError: null})
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    harness.live.fail("provider failed")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lastSnapshot(harness.session)?.connection).toBe("error")
    expect(lastSnapshot(harness.session)?.lastError).toBe("provider failed")
  })

  test("temporary transcript failure is visible without stopping voice", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    harness.live.persistence("Transcript sync failed; retrying")
    expect(lastSnapshot(harness.session)).toMatchObject({
      connection: "listening",
      lastError: "Transcript sync failed; retrying",
    })
    harness.live.persistence(null)
    expect(lastSnapshot(harness.session)).toMatchObject({connection: "listening", lastError: null})
    await harness.session.handlers["openalma:stop"]({})
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
    harness.live.persistenceOnStop = "Transcript sync failed; last turns were not saved"

    harness.live.fail("provider failed")
    await Promise.resolve()
    const stop = harness.session.handlers["openalma:stop"]({})
    release()
    await stop

    expect(harness.live.stopArgs).toEqual([false])
    expect(lastSnapshot(harness.session)).toMatchObject({
      connection: "idle",
      lastError: "Transcript sync failed; last turns were not saved",
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

  test("graceful Stop preserves a final unsaved-transcript warning", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    harness.live.persistenceOnStop = "Transcript sync failed; last turns were not saved"
    await harness.session.handlers["openalma:stop"]({})
    expect(lastSnapshot(harness.session)).toMatchObject({
      connection: "idle",
      lastError: "Transcript sync failed; last turns were not saved",
    })
  })
})
