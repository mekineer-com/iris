import {describe, expect, test} from "bun:test"

import type {GeminiCallbacks} from "./GeminiLiveController"
import {GeminiLiveController, JOURNAL_KEY} from "./GeminiLiveController"
import type {OpenAlmaConfig} from "./openAlmaConfig"
import {SessionController} from "./SessionController"
import type {MicSource, SessionSnapshot as Snapshot} from "../shared/types"

const CONFIG: OpenAlmaConfig = {
  baseUrl: "http://127.0.0.1:9999",
  userId: "Test User",
  soulId: "Test Soul",
  deviceSessionId: "test-phone",
  packageName: "com.openalma.mentra",
  version: "0.1.0",
}

function withOwnerDiscovery(fetchFn: typeof fetch, userId = CONFIG.userId): typeof fetch {
  return (async (url, init) => {
    if (String(url).endsWith("/integration/mentra/owner") && !init?.method) {
      return Response.json({user_id: userId})
    }
    return fetchFn(url, init)
  }) as typeof fetch
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
  audioSources: Array<MicSource | undefined> = []
  startModes: string[] = []
  activities: string[][] = []
  activitySources: Array<MicSource | undefined> = []
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

  sendAudio(data: string, source?: MicSource): void {
    this.sent.push(data)
    this.audioSources.push(source)
  }

  sendActivity(chunks: readonly string[], source?: MicSource): void {
    if (this.activityError) throw this.activityError
    this.activities.push([...chunks])
    this.activitySources.push(source)
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
  micHandler: ((chunk: {data: string; sampleRate?: number; format?: string; source?: string}) => void) | null = null
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
    keys: async () => [...this.stored.keys()],
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
    onAudioChunk: (handler: (chunk: {data: string; sampleRate?: number; format?: string; source?: string}) => void) => {
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
    unreadableJournal?: boolean
    fetchFn?: typeof fetch
  } = {},
) {
  const session = new FakeSession()
  for (const [key, value] of Object.entries(options.stored ?? {})) session.stored.set(key, value)
  if (options.unreadableJournal) {
    const get = session.storage.get
    session.storage.get = async key => {
      if (key === JOURNAL_KEY) throw new Error("Fictional journal read failure")
      return get(key)
    }
  }
  if (!session.stored.has("openalma.soul-id")) session.stored.set("openalma.soul-id", CONFIG.soulId)
  let live!: FakeLive
  const configs: OpenAlmaConfig[] = []
  const controller = new SessionController(session as never, {
    watchdogMs: options.watchdogMs ?? 5000,
    earconTimeoutMs: options.earconTimeoutMs,
    responseWatchdogMs: options.responseWatchdogMs,
    config: CONFIG,
    fetchFn: withOwnerDiscovery(options.fetchFn ?? (async (_url, init) => {
      if (!init?.method) {
        return new Response(JSON.stringify({souls: [CONFIG.soulId]}), {headers: {"Content-Type": "application/json"}})
      }
      const body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({soul_id: body.soul_id, created: !body.use_existing}), {
        headers: {"Content-Type": "application/json"},
      })
    }) as typeof fetch),
    createLiveController: (config, callbacks) => {
      configs.push(config)
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
    configs,
  }
}

function lastSnapshot(session: FakeSession): Snapshot | undefined {
  return session.snapshots.at(-1)
}

describe("SessionController", () => {
  test("does no network work until a phone-local profile is saved", async () => {
    const session = new FakeSession()
    let requests = 0
    const controller = new SessionController(session as never, {
      fetchFn: withOwnerDiscovery((async () => {
        requests += 1
        return new Response(JSON.stringify({souls: [CONFIG.soulId]}))
      }) as typeof fetch),
    })
    controller.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lastSnapshot(session)).toMatchObject({configured: false, soulLoading: false, lastError: null})
    expect(requests).toBe(0)
    await expect(session.handlers["openalma:start"]({mode: "continuous"})).rejects.toThrow("Set up the OpenAlma connection first")
    expect(requests).toBe(0)

    await session.handlers["openalma:set-profile"](CONFIG)
    expect(lastSnapshot(session)).toMatchObject({configured: true, soulId: "", memuAvailable: true})
    expect(JSON.parse(session.stored.get("openalma.connection-profile") ?? "")).toEqual({
      baseUrl: CONFIG.baseUrl,
      userId: CONFIG.userId,
      deviceSessionId: CONFIG.deviceSessionId,
    })
    expect(requests).toBe(1)
    await session.handlers["openalma:set-profile"]({...CONFIG, baseUrl: "http://changed.example"})
    expect(lastSnapshot(session)).toMatchObject({connectionProfile: {
      baseUrl: "http://changed.example", userId: CONFIG.userId, deviceSessionId: CONFIG.deviceSessionId,
    }})
    await expect(session.handlers["openalma:set-profile"]({...CONFIG, deviceSessionId: "other-installation"}))
      .rejects.toThrow("cannot change the owner or installation ID")
  })

  test.each([new Error("Network request failed"), new Error("The operation was aborted"), 409, 503])(
    "distinguishes discovery transport failures from server responses (%s)", async failure => {
      const session = new FakeSession()
      new SessionController(session as never, {
        config: CONFIG,
        fetchFn: (async () => {
          if (failure instanceof Error) throw failure
          return new Response("unavailable", {status: failure})
        }) as typeof fetch,
      }).start()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(lastSnapshot(session)).toMatchObject({memuAvailable: false,
        lastError: failure instanceof Error ? "Is memU running?" : `Owner discovery failed (${failure})`})
    },
  )

  test("leaves missing owner setup to the launcher", async () => {
    const session = new FakeSession()
    const requests: Array<{url: string; method: string; body: unknown}> = []
    const controller = new SessionController(session as never, {
      fetchFn: (async (url, init) => {
        const method = init?.method ?? "GET"
        const body = init?.body ? JSON.parse(String(init.body)) : null
        requests.push({url: String(url), method, body})
        if (String(url).endsWith("/owner")) {
          return Response.json({user_id: method === "POST" ? CONFIG.userId : null})
        }
        if (method === "GET") return Response.json({souls: []})
        return Response.json({soul_id: CONFIG.soulId, created: true})
      }) as typeof fetch,
    })
    controller.start()
    await new Promise((resolve) => setTimeout(resolve, 0))

    await expect(session.handlers["openalma:set-profile"](CONFIG)).rejects.toThrow("owner in the launcher")
    expect(requests.map(({method}) => method)).toEqual(["GET"])
    expect(session.stored.has("openalma.connection-profile")).toBe(false)
  })

  test("connection Save keeps Start locked during discovery", async () => {
    let entered!: () => void, finish!: () => void
    const waiting = new Promise<void>((resolve) => {entered = resolve})
    const release = new Promise<void>((resolve) => {finish = resolve})
    const h = setup({fetchFn: (async (url) => {
      if (String(url).startsWith("http://changed.example")) {entered(); await release}
      return Response.json({souls: [CONFIG.soulId]})
    }) as typeof fetch})
    const saving = h.session.handlers["openalma:set-profile"]({...CONFIG, baseUrl: "http://changed.example"})
    await waiting
    expect(lastSnapshot(h.session)?.connectionLocked).toBe(true)
    await expect(h.session.handlers["openalma:set-profile"]({...CONFIG, baseUrl: "http://other.example"}))
      .rejects.toThrow("Wait for settings or stop")
    await expect(h.session.handlers["openalma:set-soul"]({soulId: "Other Soul", useExisting: true}))
      .rejects.toThrow("Finish or recover")
    await expect(h.session.handlers["openalma:start"]({mode: "continuous"})).rejects.toThrow("Wait for settings")
    finish()
    await saving
    await h.session.handlers["openalma:start"]({mode: "continuous"})
    expect(h.configs[0].baseUrl).toBe("http://changed.example")
    await expect(h.session.handlers["openalma:set-profile"]({...CONFIG, baseUrl: "http://other.example"}))
      .rejects.toThrow("Wait for settings or stop")
    await h.session.handlers["openalma:stop"]({})
  })

  test("seeds fork defaults once without choosing a Soul or overwriting settings; stock requires a ticket", async () => {
    const session = new FakeSession()
    const installationDefaults = {baseUrl: CONFIG.baseUrl, userId: CONFIG.userId, deviceSessionId: CONFIG.deviceSessionId}
    session.stored.set("openalma.host", JSON.stringify({host_package: "com.mentra.mentra.openalma",
      host_version: "3.2.1", deviceSessionId: CONFIG.deviceSessionId}))
    const stock = new FakeSession()
    new SessionController(stock as never, {installationDefaults}).start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stock.stored.has("openalma.connection-profile")).toBe(false)
    expect(lastSnapshot(stock)?.lastError).toContain("installationTicket")
    for (const defaults of [installationDefaults,
      {baseUrl: CONFIG.baseUrl, userId: CONFIG.userId, installationTicket: "ticket-stock"}]) {
      const wrong = new FakeSession()
      wrong.stored.set("openalma.host", JSON.stringify({host_package: "com.mentra.mentra.openalma",
        host_version: "3.2.1", deviceSessionId: "other-installation"}))
      new SessionController(wrong as never, {installationDefaults: defaults,
        fetchFn: (async () => {throw new Error("Wrong bundle must not make requests")}) as typeof fetch,
      }).start()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(wrong.stored.has("openalma.connection-profile")).toBe(false)
      expect(lastSnapshot(wrong)?.lastError).toBe("Install Iris from its OpenAlma Mentra row in the launcher")
    }
    const requests: string[] = []
    const fetchFn = (async (url, init) => {
      requests.push(init?.method ?? "GET")
      return Response.json(String(url).endsWith("/owner") ? {user_id: CONFIG.userId} : {souls: []})
    }) as typeof fetch
    new SessionController(session as never, {installationDefaults: {...installationDefaults,
      deviceSessionId: ` ${CONFIG.deviceSessionId} `}, fetchFn}).start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lastSnapshot(session)).toMatchObject({configured: true, soulId: "", soulConfirmed: false})
    expect(requests.every((method) => method === "GET")).toBe(true)
    const saved = JSON.parse(session.stored.get("openalma.connection-profile") ?? "")
    expect(saved).toMatchObject(installationDefaults)
    session.stored.set("openalma.connection-profile", JSON.stringify({...saved, baseUrl: "http://changed.example"}))
    new SessionController(session as never, {installationDefaults, fetchFn}).start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(JSON.parse(session.stored.get("openalma.connection-profile") ?? "").baseUrl).toBe("http://changed.example")
  })

  test("saves a fresh candidate and exchanges its ticket before discovery or readiness", async () => {
    const session = new FakeSession()
    const installationDefaults = {baseUrl: CONFIG.baseUrl, userId: CONFIG.userId, installationTicket: "ticket-fresh"}
    const requests: Array<{url: string; body: Record<string, unknown> | null}> = []
    let reopened = false
    let entered!: () => void, finish!: () => void
    const waiting = new Promise<void>((resolve) => {entered = resolve})
    const release = new Promise<void>((resolve) => {finish = resolve})
    const fetchFn = (async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null
      requests.push({url: String(url), body})
      if (init?.method) {
        const saved = JSON.parse(session.stored.get("openalma.connection-profile")!)
        expect(saved).toMatchObject({installationTicket: "ticket-fresh", installationConfirmed: false,
          deviceSessionId: body.device_session_id})
        expect(body).toMatchObject({installation_ticket: "ticket-fresh", soul_id: null})
        expect(body.device_session_id).not.toBe(CONFIG.deviceSessionId)
        entered()
        await release
        return Response.json({ok: true})
      }
      expect(JSON.parse(session.stored.get("openalma.connection-profile")!).installationConfirmed).toBe(reopened)
      return Response.json(String(url).endsWith("/owner") ? {user_id: CONFIG.userId} : {souls: []})
    }) as typeof fetch
    new SessionController(session as never, {installationDefaults, fetchFn}).start()
    await waiting
    session.onOpenCb?.()
    expect(lastSnapshot(session)).toMatchObject({configured: true, soulLoading: true, soulConfirmed: false, soulLocked: true})
    expect(lastSnapshot(session)?.connectionProfile).not.toHaveProperty("installationTicket")
    expect(requests).toHaveLength(1)
    finish()
    await session.handlers["openalma:set-capabilities"]({microphoneEnabled: true})
    const saved = session.stored.get("openalma.connection-profile")!
    expect(lastSnapshot(session)).toMatchObject({configured: true, soulLoading: false, memuAvailable: true, soulConfirmed: false})
    expect(requests.map(({url}) => url.split("/").at(-1))).toEqual(["seen", "owner", "souls"])
    expect(JSON.parse(saved).installationConfirmed).toBe(true)
    reopened = true
    new SessionController(session as never, {installationDefaults, fetchFn}).start()
    await session.handlers["openalma:set-capabilities"]({microphoneEnabled: true})
    expect(session.stored.get("openalma.connection-profile")).toBe(saved)
    expect(requests.filter(({body}) => body)).toHaveLength(1)
  })

  test("pending exchange failure stays editable and address repair reuses its ID and ticket", async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    try {
      const session = new FakeSession()
      const installationDefaults = {baseUrl: CONFIG.baseUrl, userId: CONFIG.userId, installationTicket: "ticket-repair"}
      const reports: Record<string, unknown>[] = []
      let starts = 0
      const fetchFn = (async (url, init) => {
        if (init?.method) {
          reports.push(JSON.parse(String(init.body)))
          return String(url).startsWith(CONFIG.baseUrl)
            ? Response.json({detail: "Setup ticket is unavailable or already used"}, {status: 409})
            : Response.json({ok: true})
        }
        return Response.json(String(url).endsWith("/owner") ? {user_id: CONFIG.userId} : {souls: [CONFIG.soulId]})
      }) as typeof fetch
      new SessionController(session as never, {installationDefaults, fetchFn,
        createLiveController: (_config, callbacks) => {starts += 1; return new FakeLive(callbacks) as never},
      }).start()
      await session.handlers["openalma:set-capabilities"]({microphoneEnabled: true})
      const pending = JSON.parse(session.stored.get("openalma.connection-profile")!)
      expect(lastSnapshot(session)).toMatchObject({configured: true, connectionLocked: false,
        soulLocked: true, soulConfirmed: false, memuAvailable: false})
      expect(lastSnapshot(session)?.lastError).toContain("Installation report failed (409): Setup ticket is unavailable or already used")
      expect(lastSnapshot(session)?.lastError).toContain("Make a new Stock Install QR")
      expect(lastSnapshot(session)?.connectionProfile).toMatchObject({baseUrl: CONFIG.baseUrl, deviceSessionId: pending.deviceSessionId})
      await expect(session.handlers["openalma:set-soul"]({soulId: CONFIG.soulId, useExisting: true})).rejects.toThrow("Finish or recover")
      await expect(session.handlers["openalma:start"]({mode: "continuous"})).rejects.toThrow("Installation is not confirmed")
      expect(starts).toBe(0)
      expect(reports).toHaveLength(1)
      await session.handlers["openalma:set-profile"]({...pending, baseUrl: "http://repaired.example",
        installationTicket: "forged-ticket", installationConfirmed: true})
      expect(JSON.parse(session.stored.get("openalma.connection-profile")!)).toEqual({...pending,
        baseUrl: "http://repaired.example", installationConfirmed: true})
      expect(reports[1]).toMatchObject({device_session_id: pending.deviceSessionId, installation_ticket: "ticket-repair"})
      expect(reports[2]).toMatchObject({device_session_id: pending.deviceSessionId})
      expect(reports[2]).not.toHaveProperty("installation_ticket")
      expect(lastSnapshot(session)).toMatchObject({memuAvailable: true, soulLocked: false})
    } finally {
      process.env.NODE_ENV = previous
    }
  })

  test("failed candidate/confirmation writes or lost reply cannot admit a sitting; reopen retries the saved ID", async () => {
    for (const failure of ["candidate", "confirmation", "reply", "outage"]) {
      const session = new FakeSession()
      session.stored.set("openalma.soul-id", CONFIG.soulId)
      const installationDefaults = {baseUrl: CONFIG.baseUrl, userId: CONFIG.userId, installationTicket: "ticket-retry"}
      const save = session.storage.set
      let profileWrites = 0, failing = true, starts = 0
      session.storage.set = async (key, value) => {
        if (key === "openalma.connection-profile") {
          profileWrites += 1
          if (failing && ((failure === "candidate" && profileWrites === 1) || (failure === "confirmation" && profileWrites === 2))) {
            throw new Error("Profile write failed")
          }
        }
        await save(key, value)
      }
      const ids: string[] = []
      const fetchFn = (async (url, init) => {
        if (init?.method) {
          const body = JSON.parse(String(init.body))
          expect(body.installation_ticket).toBe("ticket-retry")
          ids.push(body.device_session_id)
          if (failing && failure === "reply") throw new Error("Response lost")
          if (failing && failure === "outage") return Response.json({detail: "Temporarily unavailable"}, {status: 503})
          return Response.json({ok: true})
        }
        return Response.json(String(url).endsWith("/owner") ? {user_id: CONFIG.userId} : {souls: [CONFIG.soulId]})
      }) as typeof fetch
      const options = {installationDefaults, fetchFn,
        createLiveController: (_config: OpenAlmaConfig, callbacks: GeminiCallbacks) => {starts += 1; return new FakeLive(callbacks) as never}}
      new SessionController(session as never, options).start()
      await session.handlers["openalma:set-capabilities"]({microphoneEnabled: true})
      expect(lastSnapshot(session)).toMatchObject({soulConfirmed: false, soulLocked: true, memuAvailable: false})
      expect(lastSnapshot(session)?.lastError).not.toContain("Make a new Stock Install QR")
      await expect(session.handlers["openalma:start"]({mode: "continuous"})).rejects.toThrow("Installation is not confirmed")
      expect(starts).toBe(0)
      if (failure === "candidate") expect(ids).toHaveLength(0)
      else expect(JSON.parse(session.stored.get("openalma.connection-profile")!).installationConfirmed).toBe(false)
      failing = false
      new SessionController(session as never, options).start()
      await session.handlers["openalma:set-capabilities"]({microphoneEnabled: true})
      if (failure !== "candidate") expect(ids[1]).toBe(ids[0])
      expect(lastSnapshot(session)).toMatchObject({soulConfirmed: true, memuAvailable: true})
      expect(JSON.parse(session.stored.get("openalma.connection-profile")!).installationConfirmed).toBe(true)
    }
  })

  test.each([true, false])("stock Update uses the QR address and keeps ID and Soul (Soul discovered: %s); a fresh copy cannot claim its target", async soulFound => {
    const session = new FakeSession()
    const saved = {...CONFIG, baseUrl: "http://saved.example", installationTicket: "old-ticket", installationConfirmed: true}
    session.stored.set("openalma.connection-profile", JSON.stringify(saved))
    session.stored.set("openalma.soul-id", CONFIG.soulId)
    const installationDefaults = {baseUrl: "http://download.example", userId: "Other User", installationTicket: "ticket-update"}
    const reports: Record<string, unknown>[] = []
    const fetchFn = (async (url, init) => {
      if (String(url).startsWith(saved.baseUrl)) throw new Error("Old address is unreachable")
      expect(String(url).startsWith(installationDefaults.baseUrl)).toBe(true)
      if (init?.method) {
        const body = JSON.parse(String(init.body))
        reports.push(body)
        return body.device_session_id === CONFIG.deviceSessionId ? Response.json({ok: true})
          : Response.json({detail: "Setup ticket does not match this app"}, {status: 409})
      }
      expect(session.stored.get("openalma.connection-profile")).toBe(JSON.stringify(saved))
      return Response.json(String(url).endsWith("/owner") ? {user_id: CONFIG.userId} : {souls: soulFound ? [CONFIG.soulId] : []})
    }) as typeof fetch
    new SessionController(session as never, {installationDefaults, fetchFn}).start()
    await session.handlers["openalma:set-capabilities"]({microphoneEnabled: true})
    expect(reports[0]).toMatchObject({user_id: CONFIG.userId, device_session_id: CONFIG.deviceSessionId,
      soul_id: CONFIG.soulId, installation_ticket: "ticket-update"})
    expect(lastSnapshot(session)).toMatchObject({soulId: CONFIG.soulId, soulConfirmed: soulFound,
      connectionProfile: {baseUrl: installationDefaults.baseUrl, userId: CONFIG.userId, deviceSessionId: CONFIG.deviceSessionId}})
    expect(session.stored.get("openalma.soul-id")).toBe(CONFIG.soulId)
    expect(JSON.parse(session.stored.get("openalma.connection-profile")!)).toMatchObject({
      baseUrl: installationDefaults.baseUrl, userId: CONFIG.userId, deviceSessionId: CONFIG.deviceSessionId,
      installationTicket: "ticket-update", installationConfirmed: true,
    })
    if (!soulFound) {
      await expect(session.handlers["openalma:start"]({mode: "manual"})).rejects.toThrow("Select or create this soul")
    }
    const fresh = new FakeSession()
    new SessionController(fresh as never, {installationDefaults, fetchFn}).start()
    await fresh.handlers["openalma:set-capabilities"]({microphoneEnabled: true})
    expect(reports[1].device_session_id).not.toBe(CONFIG.deviceSessionId)
    expect(lastSnapshot(fresh)).toMatchObject({soulLocked: true, soulConfirmed: false, memuAvailable: false})
    expect(lastSnapshot(fresh)?.lastError).toContain("Make a new Stock Install QR")
    await expect(fresh.handlers["openalma:start"]({mode: "continuous"})).rejects.toThrow("Installation is not confirmed")
  })

  test("a refused fresh claim keeps its candidate until a new Stock Install QR is supplied", async () => {
    const session = new FakeSession()
    const reports: Record<string, unknown>[] = []
    const fetchFn = (async (url, init) => {
      if (init?.method) {
        const body = JSON.parse(String(init.body))
        reports.push(body)
        return body.installation_ticket === "ticket-new"
          ? Response.json({ok: true})
          : Response.json({detail: "Setup ticket is unavailable or already used"}, {status: 409})
      }
      return Response.json(String(url).endsWith("/owner") ? {user_id: CONFIG.userId} : {souls: []})
    }) as typeof fetch
    let candidate = ""
    for (const installationTicket of ["ticket-used", "ticket-used", "ticket-new"]) {
      new SessionController(session as never, {fetchFn,
        installationDefaults: {baseUrl: CONFIG.baseUrl, userId: CONFIG.userId, installationTicket},
      }).start()
      await session.handlers["openalma:set-capabilities"]({microphoneEnabled: true})
      const saved = JSON.parse(session.stored.get("openalma.connection-profile")!)
      candidate ||= saved.deviceSessionId
      expect(saved.deviceSessionId).toBe(candidate)
      expect(saved.installationTicket).toBe(installationTicket)
      expect(saved.installationConfirmed).toBe(installationTicket === "ticket-new")
      expect(lastSnapshot(session)?.memuAvailable).toBe(installationTicket === "ticket-new")
      if (installationTicket !== "ticket-new") {
        expect(lastSnapshot(session)?.lastError).toContain("Make a new Stock Install QR")
        expect(lastSnapshot(session)?.soulLocked).toBe(true)
      }
    }
    expect(reports.map(body => body.device_session_id)).toEqual([candidate, candidate, candidate])
  })

  test("a refused Update QR never overwrites a working stock profile or its recovery journal", async () => {
    for (const detail of ["Setup ticket is unavailable or already used", "Setup ticket does not match this app"]) {
      const session = new FakeSession()
      const saved = JSON.stringify({...CONFIG, installationTicket: "ticket-confirmed", installationConfirmed: true})
      const journal = JSON.stringify({version: 1,
        scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
        resumption: {handle: "fictional-handle", updatedAt: Date.now()},
      })
      session.stored.set("openalma.connection-profile", saved)
      session.stored.set("openalma.soul-id", CONFIG.soulId)
      session.stored.set("openalma:gemini-session-v1", journal)
      const reports: Record<string, unknown>[] = []
      const configs: OpenAlmaConfig[] = []
      const fetchFn = (async (url, init) => {
        if (init?.method) {
          expect(String(url).startsWith("http://wrong.example")).toBe(true)
          expect(session.stored.get("openalma.connection-profile")).toBe(saved)
          reports.push(JSON.parse(String(init.body)))
          return Response.json({detail: detail === "Setup ticket does not match this app" ? {message: detail} : detail}, {status: 409})
        }
        expect(String(url).startsWith(CONFIG.baseUrl)).toBe(true)
        return Response.json(String(url).endsWith("/owner") ? {user_id: CONFIG.userId} : {souls: [CONFIG.soulId]})
      }) as typeof fetch
      const options = {fetchFn,
        installationDefaults: {baseUrl: "http://wrong.example", userId: "Other User", installationTicket: "ticket-wrong"},
        createLiveController: (config: OpenAlmaConfig, callbacks: GeminiCallbacks) => {
          configs.push(config)
          return new FakeLive(callbacks) as never
        },
      }
      for (let reopen = 0; reopen < 2; reopen += 1) {
        new SessionController(session as never, options).start()
        await session.handlers["openalma:set-capabilities"]({microphoneEnabled: true})
        expect(session.stored.get("openalma.connection-profile")).toBe(saved)
        expect(session.stored.get("openalma:gemini-session-v1")).toBe(journal)
        expect(lastSnapshot(session)).toMatchObject({memuAvailable: true, soulConfirmed: true, soulId: CONFIG.soulId})
        expect(lastSnapshot(session)?.lastError).toContain(detail)
        expect(lastSnapshot(session)?.lastError).toContain("existing Iris connection has been kept")
        expect(lastSnapshot(session)?.lastError).not.toContain("Make a new Stock Install QR")
        await session.handlers["openalma:start"]({mode: "manual"})
        expect(configs.at(-1)).toMatchObject({baseUrl: CONFIG.baseUrl, userId: CONFIG.userId,
          deviceSessionId: CONFIG.deviceSessionId, soulId: CONFIG.soulId,
          installationTicket: "ticket-confirmed", installationConfirmed: true})
        await session.handlers["openalma:stop"]({})
      }
      expect(reports).toHaveLength(2)
      expect(reports.every(body => body.device_session_id === CONFIG.deviceSessionId && body.installation_ticket === "ticket-wrong")).toBe(true)
    }
  })

  test.each(["reply", "confirmation", "outage", "owner", "owner-mismatch", "souls"])(
    "an uncertain Update exchange (%s) keeps its saved profile; reopen or manual Edit Connection reuses the same ID and ticket", async failure => {
      const session = new FakeSession()
      const saved = JSON.stringify({...CONFIG, installationTicket: "ticket-confirmed", installationConfirmed: true})
      session.stored.set("openalma.connection-profile", saved)
      session.stored.set("openalma.soul-id", CONFIG.soulId)
      const journal = JSON.stringify({version: 1,
        scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
        resumption: {handle: "fictional-handle", updatedAt: Date.now()},
      })
      session.stored.set(JOURNAL_KEY, journal)
      session.stored.set("openalma:recovered-chats", "fictional recovered history")
      let failing = true
      const save = session.storage.set
      session.storage.set = async (key, value) => {
        if (failing && failure === "confirmation" && key === "openalma.connection-profile") throw new Error("Profile write failed")
        await save(key, value)
      }
      const reports: Record<string, unknown>[] = []
      const urls: string[] = []
      const fetchFn = (async (url, init) => {
        urls.push(String(url))
        if (init?.method) {
          reports.push(JSON.parse(String(init.body)))
          if (failing && failure === "reply") throw new Error("Response lost")
          if (failing && failure === "outage") return Response.json({detail: "Temporarily unavailable"}, {status: 503})
          return Response.json({ok: true})
        }
        if (String(url).endsWith("/owner")) {
          if (failing && failure === "owner") return Response.json({detail: "Unavailable"}, {status: 503})
          return Response.json({user_id: failing && failure === "owner-mismatch" ? "Other User" : CONFIG.userId})
        }
        if (failing && failure === "souls") return Response.json({detail: "Unavailable"}, {status: 503})
        return Response.json({souls: [CONFIG.soulId]})
      }) as typeof fetch
      const configs: OpenAlmaConfig[] = []
      const options = {fetchFn, installationDefaults: {baseUrl: "http://download.example", userId: CONFIG.userId, installationTicket: "ticket-update"},
        createLiveController: (config: OpenAlmaConfig, callbacks: GeminiCallbacks) => {
          configs.push(config)
          return new FakeLive(callbacks) as never
        },
      }
      new SessionController(session as never, options).start()
      await session.handlers["openalma:set-capabilities"]({microphoneEnabled: true})
      expect(lastSnapshot(session)?.memuAvailable).toBe(false)
      expect(lastSnapshot(session)?.lastError).not.toContain("Make a new Stock Install QR")
      expect(session.stored.get("openalma.connection-profile")).toBe(saved)
      expect(lastSnapshot(session)?.connectionProfile?.baseUrl).toBe(CONFIG.baseUrl)
      expect(urls.every(url => url.startsWith(options.installationDefaults.baseUrl))).toBe(true)
      expect(session.stored.get(JOURNAL_KEY)).toBe(journal)
      expect(session.stored.get("openalma:recovered-chats")).toBe("fictional recovered history")
      urls.length = 0
      failing = false
      if (failure === "outage") await session.handlers["openalma:set-profile"]({...CONFIG, baseUrl: "http://repaired.example"})
      else new SessionController(session as never, options).start()
      await session.handlers["openalma:set-capabilities"]({microphoneEnabled: true})
      expect(reports).toHaveLength(2)
      expect(reports[1]).toEqual(reports[0])
      const confirmedBaseUrl = failure === "outage" ? "http://repaired.example" : options.installationDefaults.baseUrl
      expect(urls.every(url => url.startsWith(confirmedBaseUrl))).toBe(true)
      expect(JSON.parse(session.stored.get("openalma.connection-profile")!)).toMatchObject({
        baseUrl: confirmedBaseUrl,
        deviceSessionId: CONFIG.deviceSessionId, installationTicket: "ticket-update", installationConfirmed: true,
      })
      expect(lastSnapshot(session)).toMatchObject({memuAvailable: true, soulConfirmed: true})
      await session.handlers["openalma:start"]({mode: "manual"})
      expect(configs.at(-1)).toMatchObject({deviceSessionId: CONFIG.deviceSessionId,
        baseUrl: confirmedBaseUrl,
        installationTicket: "ticket-update", installationConfirmed: true})
      await session.handlers["openalma:stop"]({})
      urls.length = 0
      await session.handlers["openalma:set-profile"]({...CONFIG, baseUrl: "http://manual.example"})
      new SessionController(session as never, options).start()
      await session.handlers["openalma:set-capabilities"]({microphoneEnabled: true})
      expect(urls.every(url => url.startsWith("http://manual.example"))).toBe(true)
      expect(reports).toHaveLength(2)
      expect(lastSnapshot(session)?.connectionProfile?.baseUrl).toBe("http://manual.example")
      expect(JSON.parse(session.stored.get("openalma.connection-profile")!).baseUrl).toBe("http://manual.example")
      expect(session.stored.get("openalma.soul-id")).toBe(CONFIG.soulId)
      expect(session.stored.get(JOURNAL_KEY)).toBe(journal)
      expect(session.stored.get("openalma:recovered-chats")).toBe("fictional recovered history")
  })

  test("non-ticket conflicts preserve the real error instead of giving QR advice or admitting setup", async () => {
    const conflicts = [
      "OpenAlma owner has not been created",
      "OpenAlma owner is 'Other User', not 'Test User'",
      "All stock_01 through stock_99 names are in use",
      "Setup ticket requires the same stock app owner",
      "Setup ticket is not an app ID",
      "Installed stock app cannot become a fork host",
      "Unknown conflict",
    ]
    for (const detail of [...conflicts, "Setup ticket is unavailable or already used"]) {
      const status = conflicts.includes(detail) ? 409 : 503
      for (const confirmed of [false, true]) {
        const session = new FakeSession()
        const saved = JSON.stringify({...CONFIG, installationTicket: "ticket-confirmed", installationConfirmed: true})
        if (confirmed) session.stored.set("openalma.connection-profile", saved)
        let requests = 0
        new SessionController(session as never, {
          installationDefaults: {baseUrl: CONFIG.baseUrl, userId: CONFIG.userId, installationTicket: "ticket-new"},
          fetchFn: (async (url, init) => {
            requests += 1
            return init?.method ? Response.json({detail}, {status})
              : Response.json(String(url).endsWith("/owner") ? {user_id: CONFIG.userId} : {souls: []})
          }) as typeof fetch,
        }).start()
        await session.handlers["openalma:set-capabilities"]({microphoneEnabled: true})
        expect(lastSnapshot(session)).toMatchObject({memuAvailable: false,
          lastError: `Installation report failed (${status}): ${detail}`})
        expect(requests).toBe(1)
        if (confirmed) expect(session.stored.get("openalma.connection-profile")).toBe(saved)
        else expect(JSON.parse(session.stored.get("openalma.connection-profile")!)).toMatchObject({
          installationTicket: "ticket-new", installationConfirmed: false,
        })
      }
    }
  })

  test("rejects a profile user that differs from the discovered owner", async () => {
    for (const recovering of [false, true]) {
      const session = new FakeSession()
      const stale = {...CONFIG, userId: "Stale User"}
      session.stored.set("openalma.connection-profile", JSON.stringify(stale))
      session.stored.set("openalma.soul-id", stale.soulId)
      const journal = JSON.stringify({version: 1,
        scope: {userId: stale.userId, soulId: "Recovery Soul", deviceSessionId: stale.deviceSessionId},
        resumption: {handle: "fictional-handle", updatedAt: Date.now()},
      })
      if (recovering) session.stored.set("openalma:gemini-session-v1", journal)
      let starts = 0
      let posts = 0
      let ownerId = CONFIG.userId
      const controller = new SessionController(session as never, {
        fetchFn: (async (url, init) => {
          if (init?.method === "POST") {posts += 1; return Response.json({soul_id: stale.soulId, created: false})}
          return Response.json(String(url).endsWith("/owner") ? {user_id: ownerId} : {souls: [stale.soulId]})
        }) as typeof fetch,
        createLiveController: (_config, callbacks) => {
          starts += 1
          return new FakeLive(callbacks) as unknown as GeminiLiveController
        },
      })
      controller.start()
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(lastSnapshot(session)).toMatchObject({
        configured: true,
        connectionProfile: {baseUrl: stale.baseUrl, userId: stale.userId, deviceSessionId: stale.deviceSessionId},
        soulId: recovering ? "Recovery Soul" : stale.soulId,
        soulLocked: recovering,
        connectionLocked: false,
        souls: [],
        memuAvailable: false,
        lastError: `Connection user does not match OpenAlma owner "${CONFIG.userId}"`,
      })
      expect(session.stored.has("openalma.connection-profile")).toBe(true)
      expect(session.stored.has("openalma.soul-id")).toBe(true)
      await expect(session.handlers["openalma:start"]({mode: "continuous"})).rejects.toThrow(
        recovering ? "does not match OpenAlma owner" : "Select or create this soul",
      )
      expect(starts).toBe(0)
      if (recovering) {
        expect(session.stored.get("openalma:gemini-session-v1")).toBe(journal)
        await expect(session.handlers["openalma:set-profile"]({...stale, baseUrl: "http://repaired.example"}))
          .rejects.toThrow("does not match OpenAlma owner")
        await expect(session.handlers["openalma:set-soul"]({soulId: "Other Soul", useExisting: true}))
          .rejects.toThrow("Finish or recover")
      } else {
        await expect(session.handlers["openalma:set-soul"]({soulId: stale.soulId, useExisting: true}))
          .rejects.toThrow("does not match OpenAlma owner")
      }
      expect(posts).toBe(0)
      await expect(session.handlers["openalma:set-profile"]({...stale, userId: CONFIG.userId}))
        .rejects.toThrow("cannot change the owner or installation ID")
      expect(JSON.parse(session.stored.get("openalma.connection-profile")!).baseUrl).toBe(stale.baseUrl)
      ownerId = stale.userId
      await session.handlers["openalma:set-profile"]({...stale, baseUrl: "http://repaired.example"})
      expect(lastSnapshot(session)).toMatchObject({soulId: recovering ? "Recovery Soul" : stale.soulId,
        soulConfirmed: true, soulLocked: recovering, connectionLocked: false,
        connectionProfile: {baseUrl: "http://repaired.example", userId: stale.userId, deviceSessionId: stale.deviceSessionId}})
      expect(session.stored.get("openalma.soul-id")).toBe(stale.soulId)
      if (recovering) expect(session.stored.get("openalma:gemini-session-v1")).toBe(journal)
    }
  })

  test("direct Start waits for discovery and never starts an unavailable saved soul", async () => {
    let release!: (response: Response) => void
    const lookup = new Promise<Response>((resolve) => { release = resolve })
    const h = setup({stored: {"openalma.soul-id": "Missing Soul"}, fetchFn: (() => lookup) as typeof fetch})
    const starting = h.session.handlers["openalma:start"]({mode: "continuous"})
    const rejected = Promise.resolve(starting).catch((error: Error) => error.message)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.configs).toEqual([])
    release(new Response(JSON.stringify({souls: [CONFIG.soulId]})))
    expect(await rejected).toContain("Select or create")
    expect(h.configs).toEqual([])
    expect(lastSnapshot(h.session)?.soulId).toBe("Missing Soul")
    expect(lastSnapshot(h.session)).toMatchObject({souls: [CONFIG.soulId], soulConfirmed: false})
  })

  test("immediate Start uses the saved soul and Stop cancels a delayed lookup", async () => {
    for (const cancel of [false, true]) {
      let release!: (response: Response) => void
      const lookup = new Promise<Response>((resolve) => { release = resolve })
      const h = setup({stored: {"openalma.soul-id": "Saved Soul"}, fetchFn: (() => lookup) as typeof fetch})
      const starting = h.session.handlers["openalma:start"]({mode: "continuous"})
      expect(h.configs).toEqual([])
      if (cancel) await h.session.handlers["openalma:stop"]({})
      release(new Response(JSON.stringify({souls: ["Saved Soul"]})))
      await starting
      expect(h.configs.map((config) => config.soulId)).toEqual(cancel ? [] : ["Saved Soul"])
      await h.session.handlers["openalma:stop"]({})
    }
  })

  test("failed discovery can reconnect in place when the server returns without starting voice", async () => {
    let available = false
    const h = setup({fetchFn: (async (_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      if (!available) throw new Error("Discovery timed out")
      return Response.json({souls: [CONFIG.soulId]})
    }) as typeof fetch})
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lastSnapshot(h.session)).toMatchObject({soulLoading: false, lastError: "Discovery timed out"})
    available = true
    await h.session.handlers["openalma:set-profile"](lastSnapshot(h.session)!.connectionProfile)
    expect(lastSnapshot(h.session)).toMatchObject({memuAvailable: true, soulLoading: false,
      soulConfirmed: true, soulId: CONFIG.soulId, lastError: null})
    expect(h.configs).toEqual([])
  })

  test("pending selection excludes Start and concurrent selections", async () => {
    let release!: (response: Response) => void
    const selecting = new Promise<Response>((resolve) => { release = resolve })
    const h = setup({fetchFn: ((_url: string, init?: RequestInit) => !init?.method
      ? Promise.resolve(new Response(JSON.stringify({souls: [CONFIG.soulId]})))
      : selecting) as typeof fetch})
    const selection = h.session.handlers["openalma:set-soul"]({soulId: "Next Soul", useExisting: false})
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(h.session.handlers["openalma:start"]({mode: "continuous"})).rejects.toThrow("settings to finish")
    await expect(h.session.handlers["openalma:set-profile"]({...CONFIG, baseUrl: "http://changed.example"}))
      .rejects.toThrow("Wait for settings or stop")
    await expect(h.session.handlers["openalma:set-soul"]({soulId: "Other Soul", useExisting: false})).rejects.toThrow("Finish or recover")
    release(new Response(JSON.stringify({soul_id: "Next Soul", created: true})))
    await selection
    expect(h.configs).toEqual([])
    expect(lastSnapshot(h.session)).toMatchObject({soulId: "Next Soul", soulLocked: false})
  })

  test("discovers, explicitly reuses, and persists a soul over the keyless connection", async () => {
    const requests: Array<{url: string; init?: RequestInit}> = []
    const harness = setup({
      fetchFn: (async (url: string, init?: RequestInit) => {
        requests.push({url, init})
        if (!init?.method) {
          return new Response(JSON.stringify({souls: ["Existing Soul"]}), {headers: {"Content-Type": "application/json"}})
        }
        const body = JSON.parse(String(init?.body))
        if (!body.use_existing) {
          return new Response(JSON.stringify({detail: {reason: "existing_exact", message: "Soul exists"}}), {status: 409})
        }
        return new Response(JSON.stringify({soul_id: body.soul_id, created: false}), {
          headers: {"Content-Type": "application/json"},
        })
      }) as typeof fetch,
    })

    await expect(harness.session.handlers["openalma:set-soul"]({soulId: "Existing Soul", useExisting: false})).resolves.toEqual({
      soulId: "Existing Soul",
      confirmationRequired: true,
    })
    await expect(harness.session.handlers["openalma:set-soul"]({soulId: "Existing Soul", useExisting: true})).resolves.toEqual({
      soulId: "Existing Soul",
      created: false,
    })

    expect(requests[0]).toEqual({
      url: "http://127.0.0.1:9999/integration/mentra/souls",
      init: {signal: expect.any(AbortSignal)},
    })
    expect(JSON.parse(String(requests.at(-1)?.init?.body))).toEqual({
      soul_id: "Existing Soul",
      use_existing: true,
      user_name: CONFIG.userId,
    })
    expect(requests.at(-1)?.init?.headers).toEqual({
      "Content-Type": "application/json",
    })
    expect(harness.session.stored.get("openalma.soul-id")).toBe("Existing Soul")
    expect(lastSnapshot(harness.session)).toMatchObject({
      soulId: "Existing Soul",
      souls: ["Existing Soul"],
      soulConfirmed: true,
      soulLocked: false,
    })
  })

  test("creation uses the owner name for released servers without prompting or starting voice", async () => {
    let body: unknown
    const h = setup({fetchFn: (async (_url: string, init?: RequestInit) => {
      if (!init?.method) return Response.json({souls: [CONFIG.soulId]})
      body = JSON.parse(String(init.body))
      return Response.json({soul_id: "Fable", created: true})
    }) as typeof fetch})
    await expect(h.session.handlers["openalma:set-soul"]({soulId: "Fable", useExisting: false}))
      .resolves.toEqual({soulId: "Fable", created: true})
    expect(body).toEqual({soul_id: "Fable", use_existing: false, user_name: CONFIG.userId})
    expect(h.configs).toEqual([])
    expect(h.session.stored.get("openalma.soul-id")).toBe("Fable")
  })

  test("creation validation shows the server reason and preserves selected Soul", async () => {
    const h = setup({fetchFn: (async (_url: string, init?: RequestInit) => !init?.method
      ? Response.json({souls: [CONFIG.soulId]})
      : Response.json({detail: "Soul name must differ from the owner name"}, {status: 422})) as typeof fetch})
    await expect(h.session.handlers["openalma:set-soul"]({soulId: "Fable", useExisting: false}))
      .rejects.toThrow("Soul name must differ from the owner name")
    expect(h.session.stored.get("openalma.soul-id")).toBe(CONFIG.soulId)
    expect(h.configs).toEqual([])
    expect(lastSnapshot(h.session)).toMatchObject({soulId: CONFIG.soulId, soulLocked: false})
  })

  test("rejects a different soul returned by the server", async () => {
    const harness = setup({fetchFn: (async (_url: string, init?: RequestInit) => !init?.method
      ? Response.json({souls: [CONFIG.soulId]})
      : Response.json({soul_id: "Other Soul", created: true})) as typeof fetch})
    await expect(harness.session.handlers["openalma:set-soul"]({soulId: "Requested Soul", useExisting: false})).rejects.toThrow(
      "invalid response",
    )
    expect(harness.session.stored.get("openalma.soul-id")).toBe(CONFIG.soulId)
  })

  test("Stop keeps pending recovery locked until the original soul's journal clears", async () => {
    const h = setup()
    await h.session.handlers["openalma:start"]({mode: "continuous"})
    const previousController = h.live
    await expect(h.session.handlers["openalma:set-soul"]({soulId: "Other Soul", useExisting: true})).rejects.toThrow("Finish or recover")
    const journal = JSON.stringify({version: 1,
      scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
      resumption: {handle: "private-original-handle", updatedAt: Date.now()},
      pendingTranscripts: [{content: "Fictional pending transcript"}],
      pendingImage: {imageId: "fictional-photo"},
    })
    h.session.stored.set("openalma:gemini-session-v1", journal)
    await h.session.handlers["openalma:stop"]({})
    expect(lastSnapshot(h.session)).toMatchObject({connection: "idle", soulLocked: true})
    await expect(h.session.handlers["openalma:set-soul"]({soulId: "Other Soul", useExisting: true})).rejects.toThrow("Finish or recover")
    await h.session.handlers["openalma:set-profile"]({...CONFIG, baseUrl: "http://repaired.example"})
    expect(h.session.stored.get("openalma:gemini-session-v1")).toBe(journal)
    await h.session.handlers["openalma:start"]({mode: "continuous"})
    expect(h.live).not.toBe(previousController)
    expect(previousController.stops).toBe(1)
    expect(h.configs.map((config) => config.baseUrl)).toEqual([CONFIG.baseUrl, "http://repaired.example"])
    expect(h.configs.map((config) => config.soulId)).toEqual([CONFIG.soulId, CONFIG.soulId])
    h.session.stored.delete("openalma:gemini-session-v1")
    await h.session.handlers["openalma:stop"]({})
    await h.session.handlers["openalma:set-soul"]({soulId: "Other Soul", useExisting: true})
    expect(lastSnapshot(h.session)).toMatchObject({soulId: "Other Soul", soulLocked: false})
  })

  test("failed discovery does not confirm a saved soul", async () => {
    const harness = setup({fetchFn: (async () => new Response("unavailable", {status: 503})) as typeof fetch})
    await expect(harness.session.handlers["openalma:start"]({mode: "continuous"})).rejects.toThrow(
      "Select or create this soul",
    )
    expect(lastSnapshot(harness.session).soulConfirmed).toBe(false)
    await expect(harness.session.handlers["openalma:set-soul"]({soulId: "Other Soul", useExisting: false}))
      .rejects.toThrow("Soul discovery failed")
    const journal = JSON.stringify({version: 1,
      scope: {userId: CONFIG.userId, soulId: "Recovery Soul", deviceSessionId: CONFIG.deviceSessionId},
      pendingTranscripts: [{event_id: "fictional-session:1", sequence: 1,
        event_kind: "transcript", role: "user", content: "Unsent fictional transcript", status: "complete"}],
      pendingImage: {imageId: "fictional-image", mediaRef: "mentra_media/fictional-scope/fictional-image.png",
        providerSent: false, captureAfterCurrent: false, generation: 1, sessionId: "fictional-session"},
      resumption: {handle: "fictional-handle", updatedAt: Date.now() - 31 * 60 * 1000},
    })
    const locked = setup({stored: {"openalma:gemini-session-v1": journal,
      "openalma.microphone-enabled": "0", "openalma.camera-enabled": "0"},
      fetchFn: (async (url) => String(url).startsWith("http://changed.example")
        ? Response.json({souls: ["Recovery Soul"]})
        : new Response("unavailable", {status: 503})) as typeof fetch})
    await expect(locked.session.handlers["openalma:set-soul"]({soulId: "Other Soul", useExisting: true}))
      .rejects.toThrow("Finish or recover")
    expect(lastSnapshot(locked.session)).toMatchObject({soulId: "Recovery Soul", soulLocked: true, connectionLocked: false, memuAvailable: false,
      microphoneEnabled: false, cameraEnabled: false})
    await locked.session.handlers["openalma:set-profile"]({...CONFIG, baseUrl: "http://changed.example"})
    expect(lastSnapshot(locked.session)).toMatchObject({soulId: "Recovery Soul", soulLocked: true,
      connectionLocked: false, memuAvailable: true, microphoneEnabled: false, cameraEnabled: false})
    expect(JSON.parse(locked.session.stored.get("openalma.connection-profile")!)).toEqual({
      baseUrl: "http://changed.example", userId: CONFIG.userId,
      deviceSessionId: CONFIG.deviceSessionId,
    })
    expect(locked.session.stored.get("openalma.soul-id")).toBe(CONFIG.soulId)
    expect(locked.session.stored.get("openalma:gemini-session-v1")).toBe(journal)
    await expect(locked.session.handlers["openalma:set-soul"]({soulId: "Other Soul", useExisting: true}))
      .rejects.toThrow("Finish or recover")
    await locked.session.handlers["openalma:start"]({mode: "continuous"})
    expect(locked.configs[0]).toMatchObject({baseUrl: "http://changed.example", soulId: "Recovery Soul",
      userId: CONFIG.userId, deviceSessionId: CONFIG.deviceSessionId})
    await locked.session.handlers["openalma:stop"]({})
  })

  test("successful revalidation clears unavailable state on selection and recovery Start", async () => {
    for (const recovering of [false, true]) {
      let available = false
      const journal = JSON.stringify({version: 1,
        scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
        pendingTranscripts: [{event_id: "fictional-session:1", sequence: 1,
          event_kind: "transcript", role: "user", content: "Fictional unsent transcript", status: "complete"}],
      })
      const h = setup({stored: recovering ? {"openalma:gemini-session-v1": journal} : {},
        fetchFn: (async (_url, init) => {
          if (!available) return new Response("unavailable", {status: 503})
          if (!init?.method) return Response.json({souls: [CONFIG.soulId, "Discovered Soul"]})
          return Response.json({soul_id: CONFIG.soulId, created: false})
        }) as typeof fetch})
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(lastSnapshot(h.session)?.memuAvailable).toBe(false)
      available = true
      if (recovering) await h.session.handlers["openalma:start"]({mode: "continuous"})
      else await h.session.handlers["openalma:set-soul"]({soulId: CONFIG.soulId, useExisting: true})
      expect(lastSnapshot(h.session)).toMatchObject({memuAvailable: true, lastError: null,
        souls: [CONFIG.soulId, "Discovered Soul"], soulId: CONFIG.soulId})
      if (recovering) {
        expect(h.session.stored.get("openalma:gemini-session-v1")).toBe(journal)
        await h.session.handlers["openalma:stop"]({})
      }
    }
  })

  test("keeps a recovered journal soul locked and binds each new sitting to its selected soul", async () => {
    const journal = JSON.stringify({
      version: 1,
      scope: {userId: "Test User", soulId: "Recovery Soul", deviceSessionId: "test-phone"},
      resumption: {handle: "fictional-handle", updatedAt: Date.now()},
    })
    const locked = setup({stored: {[JOURNAL_KEY]: "Preserved unreadable original",
      [`${JOURNAL_KEY}:2`]: journal.replace("Recovery Soul", "Older Soul"), [`${JOURNAL_KEY}:10`]: journal}})
    await expect(locked.session.handlers["openalma:set-soul"]({soulId: "New Soul", useExisting: false})).rejects.toThrow(
      "Finish or recover",
    )
    expect(lastSnapshot(locked.session)).toMatchObject({soulId: "Recovery Soul", soulLocked: true})
    await locked.session.handlers["openalma:start"]({mode: "continuous"})
    const keys = locked.session.storage.keys
    locked.session.storage.keys = async () => {throw new Error("Fictional key enumeration failure")}
    await locked.session.handlers["openalma:stop"]({})
    expect(lastSnapshot(locked.session)).toMatchObject({soulId: "Recovery Soul", soulLocked: true})
    await locked.session.handlers["openalma:set-profile"](CONFIG)
    expect(lastSnapshot(locked.session)).toMatchObject({soulId: "Recovery Soul", soulLocked: true})
    locked.session.storage.keys = keys
    locked.session.stored.set(`${JOURNAL_KEY}:10`, "")
    await locked.session.handlers["openalma:set-profile"](CONFIG)
    expect(lastSnapshot(locked.session)).toMatchObject({soulId: CONFIG.soulId, soulLocked: false})

    const harness = setup()
    await harness.session.handlers["openalma:set-soul"]({soulId: "First Soul", useExisting: false})
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    await harness.session.handlers["openalma:stop"]({})
    await harness.session.handlers["openalma:set-profile"]({...CONFIG, baseUrl: "http://changed.example"})
    expect(lastSnapshot(harness.session)?.soulId).toBe("First Soul")
    await harness.session.handlers["openalma:set-soul"]({soulId: "Second Soul", useExisting: false})
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    expect(harness.configs.map((config) => config.soulId)).toEqual(["First Soul", "Second Soul"])
  })

  test("an unreadable backup does not mark the server unavailable or prevent Start", async () => {
    const raw = "Unreadable fictional original"
    const h = setup({stored: {[JOURNAL_KEY]: raw}, unreadableJournal: true})
    await h.session.handlers["openalma:start"]({mode: "continuous"})
    expect(lastSnapshot(h.session)).toMatchObject({memuAvailable: true, soulId: CONFIG.soulId})
    expect(h.configs).toHaveLength(1)
    await h.session.handlers["openalma:stop"]({})
    expect(h.session.stored.get(JOURNAL_KEY)).toBe(raw)
  })

  test("empty or expired recovery does not pin a soul", async () => {
    for (const resumption of [null, {handle: "expired", updatedAt: Date.now() - 31 * 60 * 1000}]) {
      const journal = JSON.stringify({version: 1,
        scope: {userId: CONFIG.userId, soulId: "Old Soul", deviceSessionId: CONFIG.deviceSessionId},
        pendingTranscripts: [], pendingImage: null, resumption,
      })
      const h = setup({stored: {"openalma:gemini-session-v1": journal}})
      await h.session.handlers["openalma:set-soul"]({soulId: "New Soul", useExisting: false})
      expect(lastSnapshot(h.session)).toMatchObject({soulId: "New Soul", soulLocked: false})
    }
  })

  test("installation reports the stored and then selected soul", async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    const reports: string[] = []
    const hostVersions: string[] = []
    let reportStatus = 200
    try {
      const h = setup({stored: {"openalma.soul-id": "Stored Soul",
        "openalma.host": JSON.stringify({host_package: "com.mentra.mentra.openalma", host_version: "3.2.0", deviceSessionId: CONFIG.deviceSessionId})}, fetchFn: (async (url, init) => {
        if (!init?.method) return Response.json({souls: ["Stored Soul"]})
        const body = JSON.parse(String(init?.body))
        if (String(url).endsWith("/installation/seen")) {
          reports.push(body.soul_id)
          hostVersions.push(body.host_version)
          return Response.json({ok: true}, {status: reportStatus})
        }
        return Response.json({soul_id: body.soul_id, created: true})
      }) as typeof fetch})
      await h.session.handlers["openalma:set-capabilities"]({microphoneEnabled: true})
      h.session.stored.set("openalma.host", JSON.stringify({host_package: "com.mentra.mentra.openalma", host_version: "3.2.1", deviceSessionId: CONFIG.deviceSessionId}))
      await h.session.handlers["openalma:set-soul"]({soulId: "Selected Soul", useExisting: false})
      expect(reports).toEqual(["Stored Soul", "Selected Soul"])
      expect(hostVersions).toEqual(["3.2.0", "3.2.1"])
      reportStatus = 503
      await h.session.handlers["openalma:set-soul"]({soulId: "Selected Soul", useExisting: true})
      expect(lastSnapshot(h.session)).toMatchObject({memuAvailable: false,
        soulId: "Selected Soul", lastError: "Installation report failed (503)"})
      reportStatus = 200
      h.session.stored.set("openalma.host", "{}")
      await h.session.handlers["openalma:set-soul"]({soulId: "Selected Soul", useExisting: true})
      expect(lastSnapshot(h.session)).toMatchObject({memuAvailable: false,
        lastError: "Invalid Mentra host marker"})
    } finally {
      process.env.NODE_ENV = previous
    }
  })

  test("routes images only while a sitting is active", async () => {
    const harness = setup()
    await expect(harness.session.handlers["openalma:image"]({})).rejects.toThrow("Start Iris")
    for (const action of ["retry", "discard"]) {
      await expect(harness.session.handlers["openalma:pending-image"]({action})).rejects.toThrow("Start Iris")
    }
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    const image = {imageId: "image-1", mimeType: "image/png", data: "AQID"}
    await harness.session.handlers["openalma:image"](image)
    expect(harness.live.images).toEqual([image])
    await harness.session.handlers["openalma:pending-image"]({action: "retry"})
    await harness.session.handlers["openalma:pending-image"]({action: "discard"})
    expect([harness.live.imageRetries, harness.live.imageDiscards]).toEqual([1, 1])
    await harness.session.handlers["openalma:stop"]({})
    for (const action of ["retry", "discard"]) {
      await expect(harness.session.handlers["openalma:pending-image"]({action})).rejects.toThrow("Start Iris")
    }
  })

  test("projects provider rollover as reconnecting with Stop ownership", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    harness.live.reconnecting(true)
    expect(lastSnapshot(harness.session)?.connection).toBe("reconnecting")
    expect(lastSnapshot(harness.session)?.connectionLocked).toBe(true)
    await expect(harness.session.handlers["openalma:set-profile"]({...CONFIG, baseUrl: "http://changed.example"}))
      .rejects.toThrow("Wait for settings or stop")
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
    harness.session.micHandler?.({data: silentPcm(), format: "pcm_s16le", sampleRate: 16000, source: "glasses"})
    expect(harness.live.sent).toEqual([silentPcm()])

    harness.live.audio()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lastSnapshot(harness.session)?.connection).toBe("speaking")
    expect(harness.session.streams[0]?.opts.sampleRate).toBe(24000)
    expect(harness.session.streams[0]?.writes).toEqual([silentPcm()])
    harness.session.micHandler?.({data: silentPcm(), format: "pcm_s16le", sampleRate: 16000, source: "phone"})
    expect(harness.live.sent).toEqual([silentPcm()])
    expect(harness.live.audioSources).toEqual(["glasses"])
    harness.live.turnComplete()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.session.streams[0]?.closed).toBe(true)
    expect(lastSnapshot(harness.session)?.connection).toBe("listening")
    harness.session.micHandler?.({data: silentPcm(), format: "pcm_s16le", sampleRate: 16000})
    expect(harness.live.sent).toEqual([silentPcm(), silentPcm()])
    expect(harness.live.audioSources).toEqual(["glasses", undefined])
  })

  test("normalizes selected microphone sources without retaining stale knowledge", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    for (const source of ["glasses", "phone", "bluetooth", "bluetoothClassic", "", undefined, "unknown"]) {
      harness.session.micHandler?.({data: silentPcm(), format: "pcm_s16le", sampleRate: 16000, source})
    }
    expect(harness.live.audioSources).toEqual(["glasses", "phone", "bluetooth", "bluetoothClassic", undefined, undefined, undefined])
    await harness.session.handlers["openalma:stop"]({})
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
    await new Promise((resolve) => setTimeout(resolve, 0))
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
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lastSnapshot(harness.session)?.connection).toBe("starting")
    expect(lastSnapshot(harness.session)?.connectionLocked).toBe(true)
    await expect(harness.session.handlers["openalma:set-profile"]({...CONFIG, baseUrl: "http://changed.example"}))
      .rejects.toThrow("Wait for settings or stop")

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
      configured: true,
      connectionProfile: {baseUrl: CONFIG.baseUrl,
        userId: CONFIG.userId, deviceSessionId: CONFIG.deviceSessionId},
      mode: "continuous",
      connection: "idle",
      soulId: "Test Soul",
      souls: [],
      soulLoading: true,
      soulConfirmed: false,
      soulLocked: true,
      connectionLocked: true,
      memuAvailable: null,
      manualPhase: "idle",
      microphoneEnabled: true,
      cameraEnabled: true,
      photoRetryPending: false,
      lastError: null,
      usageTotalTokens: null,
      durationWarning: false,
    })
    harness.controller.reportInstallationError()
    expect(lastSnapshot(harness.session)).toMatchObject({memuAvailable: false, lastError: null})
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
    await harness.session.handlers["openalma:pending-image"]({action: "retry"})
    expect(harness.live.imageRetries).toBe(1)

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
    harness.session.micHandler?.({data: testPcm(1), format: "pcm_s16le", sampleRate: 16000, source: "phone"})
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(lastSnapshot(harness.session)).toMatchObject({connection: "listening", manualPhase: "idle"})

    harness.session.handlers["openalma:manual-action"]({action: "talk"})
    expect(() => harness.session.handlers["openalma:manual-action"]({action: "done"})).toThrow(
      "No audio was recorded",
    )
    harness.session.micHandler?.({data: testPcm(1), format: "pcm_s16le", sampleRate: 16000, source: "glasses"})
    harness.session.handlers["openalma:manual-action"]({action: "done"})
    expect(harness.live.activities).toEqual([])

    harness.session.handlers["openalma:manual-action"]({action: "redo"})
    harness.session.micHandler?.({data: testPcm(2), format: "pcm_s16le", sampleRate: 16000, source: "bluetoothClassic"})
    harness.session.handlers["openalma:manual-action"]({action: "done"})
    harness.session.micHandler?.({data: testPcm(3), format: "pcm_s16le", sampleRate: 16000, source: "phone"})
    harness.session.handlers["openalma:manual-action"]({action: "send"})
    expect(harness.live.activities).toEqual([[testPcm(2)]])
    expect(harness.live.activitySources).toEqual(["bluetoothClassic"])
    expect(lastSnapshot(harness.session)?.manualPhase).toBe("submitted")

    harness.live.turnComplete()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lastSnapshot(harness.session)).toMatchObject({connection: "listening", manualPhase: "idle"})
    harness.session.handlers["openalma:manual-action"]({action: "talk"})
    harness.session.micHandler?.({data: testPcm(1), format: "pcm_s16le", sampleRate: 16000})
    harness.session.handlers["openalma:manual-action"]({action: "done"})
    harness.session.handlers["openalma:manual-action"]({action: "send"})
    expect(harness.live.activitySources).toEqual(["bluetoothClassic", undefined])
    await harness.session.handlers["openalma:stop"]({})
  })

  test.each([undefined, "", "unknown"])("Manual clears a source on accepted unlabelled audio (%s)", async source => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "manual"})
    harness.session.handlers["openalma:manual-action"]({action: "talk"})
    harness.session.micHandler?.({data: testPcm(1), format: "pcm_s16le", sampleRate: 16000, source: "glasses"})
    harness.session.micHandler?.({data: testPcm(2), format: "pcm_s16le", sampleRate: 16000, source})
    harness.session.handlers["openalma:manual-action"]({action: "done"})
    harness.session.handlers["openalma:manual-action"]({action: "send"})
    expect(harness.live.activitySources).toEqual([undefined])
    await harness.session.handlers["openalma:stop"]({})
  })

  test("Manual keeps a Review draft when the provider is not ready", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "manual"})
    harness.session.handlers["openalma:manual-action"]({action: "talk"})
    harness.session.micHandler?.({data: testPcm(1), format: "pcm_s16le", sampleRate: 16000, source: "glasses"})
    harness.session.handlers["openalma:manual-action"]({action: "done"})
    harness.live.activityError = new Error("Gemini socket is not ready")

    expect(() => harness.session.handlers["openalma:manual-action"]({action: "send"})).toThrow(
      "Gemini socket is not ready",
    )
    expect(lastSnapshot(harness.session)?.manualPhase).toBe("review")
    harness.session.micHandler?.({data: testPcm(2), format: "pcm_s16le", sampleRate: 16000, source: "phone"})
    harness.live.activityError = null
    harness.session.handlers["openalma:manual-action"]({action: "send"})
    expect(harness.live.activities).toEqual([[testPcm(1)]])
    expect(harness.live.activitySources).toEqual(["glasses"])
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
      source: "glasses",
    })
    expect(lastSnapshot(harness.session)).toMatchObject({manualPhase: "recording", lastError: null})

    harness.session.micHandler?.({data: testPcm(1), format: "pcm_s16le", sampleRate: 16000, source: "phone"})
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
    expect(harness.live.activitySources).toEqual(["glasses"])
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
    for (let i = 0; i < 20 && !harness.session.streams[0]?.closed; i++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(harness.session.streams[0]?.closed).toBe(true)

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
    expect(lastSnapshot(harness.session)).toMatchObject({connection: "stopping", connectionLocked: true})
    await expect(harness.session.handlers["openalma:set-profile"]({...CONFIG, baseUrl: "http://changed.example"}))
      .rejects.toThrow("Wait for settings or stop")
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

  test("obsolete queued finish cannot close the reflection writer", async () => {
    const harness = setup()
    await harness.session.handlers["openalma:start"]({mode: "continuous"})
    harness.live.audio()
    await new Promise(resolve => setTimeout(resolve, 0))
    let releaseOld!: () => void
    harness.session.closeGate = new Promise<void>(resolve => {releaseOld = resolve})
    harness.live.turnComplete()
    harness.live.turnComplete()
    for (let i = 0; i < 20 && !harness.session.streams[0]?.closed; i++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(harness.session.streams[0]?.closed).toBe(true)
    harness.session.closeGate = null
    let releaseStop!: () => void
    harness.live.stopGate = new Promise<void>(resolve => {releaseStop = resolve})
    harness.live.audioOnStop = true
    const stop = harness.session.handlers["openalma:stop"]({})
    for (let i = 0; i < 20 && harness.session.streams.length < 2; i++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(harness.session.streams).toHaveLength(2)
    releaseOld()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(harness.session.streams[1].closed).toBe(false)
    releaseStop()
    await stop
    expect(harness.session.streams[1].closed).toBe(true)
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
