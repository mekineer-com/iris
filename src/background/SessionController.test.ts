import {describe, expect, test} from "bun:test"

import {MockProvider} from "./MockProvider"
import {SessionController} from "./SessionController"

type Snapshot = {mode: string; connection: string; lastError: string | null}

function silentPcm(): string {
  return Buffer.alloc(8).toString("base64")
}

class FakeSession {
  micHandler: ((chunk: {data: string; sampleRate?: number; format?: string}) => void) | null = null
  micSubs = 0
  micStops = 0
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
  events: string[] = []

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
      return () => {
        delete this.handlers[channel]
      }
    },
  }

  mic = {
    onAudioChunk: (handler: (chunk: {data: string}) => void) => {
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
    createStream: async (opts: {sampleRate: number; stopOtherAudio?: boolean}) => {
      if (this.createGate) {
        const gate = this.createGate
        this.createGate = null
        await gate
      }
      const rec = {opts, writes: [] as unknown[], aborted: false, closed: false}
      this.streams.push(rec)
      this.events.push("create")
      return {
        write: async (chunk: unknown) => {
          rec.writes.push(chunk)
          this.events.push("write")
          return {bufferedMs: 0}
        },
        close: async () => {
          rec.closed = true
          this.events.push("close")
          return {}
        },
        abort: async () => {
          rec.aborted = true
          this.events.push("abort")
        },
      }
    },
  }
}

function lastSnapshot(session: FakeSession): Snapshot | undefined {
  return session.snapshots[session.snapshots.length - 1]
}

describe("SessionController", () => {
  test("start feeds loopback speech then stop tears down mic", async () => {
    const session = new FakeSession()
    const controller = new SessionController(session as never, {watchdogMs: 5000})
    controller.start()
    await session.handlers["openalma:start"]({mode: "continuous"})
    expect(session.micSubs).toBe(1)
    expect(session.streams[0]?.closed).toBe(true)
    session.micHandler?.({data: silentPcm()})
    session.micHandler?.({data: silentPcm()})
    session.micHandler?.({data: silentPcm()})
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(session.streams.length).toBe(2)
    expect(session.streams[1]?.writes.length).toBe(1)
    await session.handlers["openalma:stop"]({})
    expect(session.micHandler).toBeNull()
    expect(session.micStops).toBeGreaterThan(0)
    expect(lastSnapshot(session)?.connection).toBe("idle")
  })

  test("interrupt does not open a new speech stream from stale work", async () => {
    const session = new FakeSession()
    const controller = new SessionController(session as never, {
      watchdogMs: 5000,
      provider: new MockProvider({loopbackAfterFrames: 1}),
    })
    controller.start()
    await session.handlers["openalma:start"]({mode: "continuous"})
    let release!: () => void
    session.createGate = new Promise<void>((resolve) => {
      release = resolve
    })
    session.micHandler?.({data: silentPcm()})
    await Promise.resolve()
    await controller.interrupt()
    const during = session.streams.length
    release()
    await Promise.resolve()
    await Promise.resolve()
    expect(session.streams.length).toBe(during + 1)
    expect(session.streams[session.streams.length - 1]?.aborted).toBe(true)
  })

  test("stop during starting skips mic subscribe", async () => {
    const session = new FakeSession()
    let release!: () => void
    session.createGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const controller = new SessionController(session as never, {watchdogMs: 5000})
    controller.start()
    const start = session.handlers["openalma:start"]({mode: "manual"})
    await session.handlers["openalma:stop"]({})
    release()
    await start
    expect(session.micSubs).toBe(0)
    expect(lastSnapshot(session)?.connection).toBe("idle")
  })

  test("watchdog failure plays disconnected earcon once", async () => {
    const session = new FakeSession()
    const played: string[] = []
    const controller = new SessionController(session as never, {watchdogMs: 15})
    const play = controller.playEarcon.bind(controller)
    controller.playEarcon = async (name) => {
      played.push(name)
      return play(name)
    }
    controller.start()
    await session.handlers["openalma:start"]({mode: "continuous"})
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(lastSnapshot(session)?.connection).toBe("error")
    expect(played.filter((name) => name === "disconnected")).toEqual(["disconnected"])
  })

  test("watchdog does not fire after stop", async () => {
    const session = new FakeSession()
    const controller = new SessionController(session as never, {watchdogMs: 30})
    controller.start()
    await session.handlers["openalma:start"]({mode: "continuous"})
    await session.handlers["openalma:stop"]({})
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(lastSnapshot(session)?.connection).toBe("idle")
    expect(lastSnapshot(session)?.lastError).toBeNull()
  })

  test("second start while listening is a no-op", async () => {
    const session = new FakeSession()
    const controller = new SessionController(session as never, {watchdogMs: 5000})
    controller.start()
    await session.handlers["openalma:start"]({mode: "continuous"})
    expect(session.micSubs).toBe(1)
    await session.handlers["openalma:start"]({mode: "continuous"})
    expect(session.micSubs).toBe(1)
  })

  test("onOpen and RPCs are registered", async () => {
    const session = new FakeSession()
    const controller = new SessionController(session as never, {watchdogMs: 5000})
    controller.start()
    expect(session.onOpenCb).toBeTruthy()
    session.onOpenCb?.()
    expect(session.snapshots[0]).toEqual({
      mode: "continuous",
      connection: "idle",
      lastError: null,
    })
    expect(typeof session.handlers["openalma:start"]).toBe("function")
    expect(typeof session.handlers["openalma:stop"]).toBe("function")
    expect(typeof session.handlers["openalma:set-mode"]).toBe("function")
    await session.handlers["openalma:set-mode"]({mode: "manual"})
    expect(lastSnapshot(session)?.mode).toBe("manual")
    await session.handlers["openalma:start"]({mode: "manual"})
    await session.handlers["openalma:stop"]({})
    expect(lastSnapshot(session)?.connection).toBe("idle")
  })

  test("earcon writer closes before speech createStream", async () => {
    const session = new FakeSession()
    const controller = new SessionController(session as never, {
      watchdogMs: 5000,
      provider: new MockProvider({loopbackAfterFrames: 1}),
    })
    controller.start()
    await session.handlers["openalma:start"]({mode: "continuous"})
    session.micHandler?.({data: silentPcm()})
    await Promise.resolve()
    await Promise.resolve()
    const speechCreate = session.events.lastIndexOf("create")
    const earconClose = session.events.indexOf("close")
    expect(session.streams.length).toBe(2)
    expect(earconClose).toBeGreaterThanOrEqual(0)
    expect(earconClose).toBeLessThan(speechCreate)
  })

  test("stop during fail leaves idle not error", async () => {
    const session = new FakeSession()
    const controller = new SessionController(session as never, {watchdogMs: 15})
    controller.start()
    await session.handlers["openalma:start"]({mode: "continuous"})
    let release!: () => void
    session.createGate = new Promise<void>((resolve) => {
      release = resolve
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(lastSnapshot(session)?.connection).toBe("stopping")
    await session.handlers["openalma:stop"]({})
    release()
    await Promise.resolve()
    await Promise.resolve()
    expect(lastSnapshot(session)?.connection).toBe("idle")
    expect(lastSnapshot(session)?.lastError).toBeNull()
  })
})
