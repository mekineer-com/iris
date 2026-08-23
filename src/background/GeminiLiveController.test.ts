import {describe, expect, test} from "bun:test"

import {GeminiLiveController} from "./GeminiLiveController"
import type {OpenAlmaConfig} from "./openAlmaConfig"

const CONFIG: OpenAlmaConfig = {
  baseUrl: "http://127.0.0.1:9999",
  bearer: "fictional-bearer",
  userId: "Test User",
  soulId: "Test Soul",
  deviceSessionId: "test-phone",
}

class FakeSocket {
  readyState = 0
  sent: string[] = []
  private listeners: Record<string, Array<(event: any) => void>> = {}

  addEventListener(type: string, listener: (event: any) => void): void {
    ;(this.listeners[type] ??= []).push(listener)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  open(): void {
    this.readyState = 1
    this.emit("open", {})
  }

  message(value: unknown): void {
    this.emit("message", {data: typeof value === "string" ? value : JSON.stringify(value)})
  }

  error(): void {
    this.emit("error", {})
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit("close", {})
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener(event)
  }
}

function harness(
  options: {
    heartbeatMs?: number
    setupTimeoutMs?: number
    heartbeatStatus?: number
    startGate?: Promise<void>
    startStatus?: number
    startBody?: unknown
    leaseSeconds?: number
  } = {},
) {
  const sockets: FakeSocket[] = []
  const requests: Array<{url: string; body: any; authorization: string | null}> = []
  const audio: string[] = []
  const events: string[] = []
  const errors: string[] = []
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body ?? "{}"))
    requests.push({url, body, authorization: new Headers(init?.headers).get("Authorization")})
    if (url.endsWith("/session/start")) {
      if (options.startGate) await options.startGate
      return Response.json(
        options.startBody ?? {
          session_id: "test-phone",
          ephemeral_token: "ephemeral/test",
          websocket: {
            api_version: "v1alpha",
            method: "BidiGenerateContentConstrained",
            input_audio_rate_hz: 16000,
            output_audio_rate_hz: 24000,
          },
          lease_seconds: options.leaseSeconds ?? 90,
        },
        {status: options.startStatus ?? 200},
      )
    }
    if (url.endsWith("/heartbeat")) return Response.json({ok: true}, {status: options.heartbeatStatus ?? 200})
    return Response.json({ok: true})
  }
  const controller = new GeminiLiveController(
    CONFIG,
    {
      onAudio: (data) => audio.push(data),
      onTurnComplete: () => events.push("turnComplete"),
      onInterrupted: () => events.push("interrupted"),
      onError: (error) => errors.push(error.message),
    },
    {
      fetchFn: fetchFn as typeof fetch,
      openSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      heartbeatMs: options.heartbeatMs,
      setupTimeoutMs: options.setupTimeoutMs,
    },
  )
  return {controller, sockets, requests, audio, events, errors}
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 0))
  expect(predicate()).toBe(true)
}

async function start(h: ReturnType<typeof harness>): Promise<void> {
  const starting = h.controller.start()
  await waitFor(() => h.sockets.length === 1)
  h.sockets[0].open()
  expect(JSON.parse(h.sockets[0].sent[0])).toEqual({setup: {sessionResumption: {}}})
  h.sockets[0].message({setupComplete: {}})
  await starting
}

describe("GeminiLiveController", () => {
  test("starts with the exact OpenAlma and Gemini contracts", async () => {
    const h = harness()
    await start(h)
    expect(h.requests[0]).toEqual({
      url: "http://127.0.0.1:9999/integration/mentra/session/start",
      body: {
        user_id: "Test User",
        soul_id: "Test Soul",
        device_session_id: "test-phone",
        mode: "continuous",
      },
      authorization: "Bearer fictional-bearer",
    })
    h.controller.sendAudio("AAAA")
    expect(JSON.parse(h.sockets[0].sent[1])).toEqual({
      realtimeInput: {audio: {data: "AAAA", mimeType: "audio/pcm;rate=16000"}},
    })
    await h.controller.stop()
    expect(h.requests.filter((request) => request.url.endsWith("/end"))).toHaveLength(1)
  })

  test("iterates audio, transcript, interruption, and turn completion independently", async () => {
    const h = harness()
    await start(h)
    h.sockets[0].message({
      serverContent: {
        modelTurn: {
          parts: [{inlineData: {data: "AAAAAA=="}}, {text: "ignored"}, {inlineData: {data: "AAAAAA=="}}],
        },
        inputTranscription: {text: "hello"},
        outputTranscription: {text: "hi"},
        turnComplete: true,
      },
    })
    expect(h.audio).toEqual(["AAAAAA==", "AAAAAA=="])
    expect(h.events).toEqual(["turnComplete"])
    await h.controller.stop()
  })

  test("interruption drops residual audio from the same server payload", async () => {
    const h = harness()
    await start(h)
    h.sockets[0].message({
      serverContent: {
        interrupted: true,
        modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]},
      },
    })
    expect(h.events).toEqual(["interrupted"])
    expect(h.audio).toEqual([])
    await h.controller.stop()
  })

  test("resumes once with the latest private handle", async () => {
    const h = harness()
    await start(h)
    h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
    h.sockets[0].error()
    await waitFor(() => h.sockets.length === 2)
    expect(() => h.controller.sendAudio("AAAA")).not.toThrow()
    h.sockets[1].open()
    expect(JSON.parse(h.sockets[1].sent[0])).toEqual({
      setup: {sessionResumption: {handle: "private-handle"}},
    })
    h.sockets[1].message({setupComplete: {}})
    h.sockets[0].error()
    expect(h.errors).toEqual([])
    h.controller.sendAudio("AAAA")
    expect(h.sockets[1].sent).toHaveLength(2)
    h.sockets[1].close()
    await waitFor(() => h.errors.length === 1)
    expect(h.sockets).toHaveLength(2)
    expect(h.errors).toEqual(["Gemini connection closed"])
    await h.controller.stop()
  })

  test("malformed known messages fail loud after setup", async () => {
    const h = harness()
    await start(h)
    h.sockets[0].message({serverContent: {modelTurn: {parts: [{inlineData: {data: "bad"}}]}}})
    expect(h.errors).toEqual(["Gemini returned malformed audio"])
    await h.controller.stop()
  })

  test("setup timeout ends the lease", async () => {
    const h = harness({setupTimeoutMs: 10})
    const starting = h.controller.start()
    await waitFor(() => h.sockets.length === 1)
    h.sockets[0].open()
    await expect(starting).rejects.toThrow("Gemini setup timed out")
    expect(h.requests.filter((request) => request.url.endsWith("/end"))).toHaveLength(1)
  })

  test("malformed successful Start and setup socket failure end their leases", async () => {
    const malformed = harness({startBody: {session_id: "wrong"}})
    await expect(malformed.controller.start()).rejects.toThrow("invalid session contract")
    expect(malformed.sockets).toHaveLength(0)
    expect(malformed.requests.filter((request) => request.url.endsWith("/end"))).toHaveLength(1)

    const socketFailure = harness()
    const starting = socketFailure.controller.start()
    await waitFor(() => socketFailure.sockets.length === 1)
    socketFailure.sockets[0].error()
    await expect(starting).rejects.toThrow("Gemini socket failed during setup")
    expect(socketFailure.requests.filter((request) => request.url.endsWith("/end"))).toHaveLength(1)
  })

  test("failed Start does not claim a lease", async () => {
    const h = harness({startStatus: 503})
    await expect(h.controller.start()).rejects.toThrow("OpenAlma Start failed (503)")
    expect(h.requests.filter((request) => request.url.endsWith("/end"))).toHaveLength(0)
  })

  test("Stop during Start does not open a stale socket and ends the late lease", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness({startGate: gate})
    const starting = h.controller.start()
    await waitFor(() => h.requests.length === 1)
    await h.controller.stop()
    release()
    await expect(starting).rejects.toThrow("Gemini start cancelled")
    expect(h.sockets).toHaveLength(0)
    expect(h.requests.filter((request) => request.url.endsWith("/end"))).toHaveLength(1)
  })

  test("heartbeat failure becomes observable", async () => {
    const h = harness({leaseSeconds: 0.03, heartbeatStatus: 404})
    await start(h)
    await waitFor(() => h.errors.length === 1)
    expect(h.errors).toEqual(["OpenAlma heartbeat failed (404)"])
    await h.controller.stop()
  })
})
