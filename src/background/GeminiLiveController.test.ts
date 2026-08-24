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
    startResults?: Array<{status: number; body: unknown}>
    leaseSeconds?: number
    appendStatuses?: number[]
  } = {},
) {
  const sockets: FakeSocket[] = []
  const requests: Array<{url: string; body: any; authorization: string | null}> = []
  const audio: string[] = []
  const events: string[] = []
  const errors: string[] = []
  const persistenceErrors: Array<string | null> = []
  const appendStatuses = [...(options.appendStatuses ?? [])]
  const startResults = [...(options.startResults ?? [])]
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body ?? "{}"))
    requests.push({url, body, authorization: new Headers(init?.headers).get("Authorization")})
    if (url.endsWith("/session/start")) {
      if (options.startGate) await options.startGate
      const result = startResults.shift()
      return Response.json(
        result?.body ?? options.startBody ?? {
          session_id: "sitting-1",
          next_transcript_sequence: 41,
          ephemeral_token: "ephemeral/test",
          websocket: {
            api_version: "v1alpha",
            method: "BidiGenerateContentConstrained",
            input_audio_rate_hz: 16000,
            output_audio_rate_hz: 24000,
          },
          lease_seconds: options.leaseSeconds ?? 90,
        },
        {status: result?.status ?? options.startStatus ?? 200},
      )
    }
    if (url.endsWith("/heartbeat")) return Response.json({ok: true}, {status: options.heartbeatStatus ?? 200})
    if (url.endsWith("/transcripts/append")) {
      return Response.json(
        {ok: true, ack_sequence: body.events.at(-1)?.sequence ?? 0},
        {status: appendStatuses.shift() ?? 200},
      )
    }
    return Response.json({ok: true})
  }
  const controller = new GeminiLiveController(
    CONFIG,
    {
      onAudio: (data) => audio.push(data),
      onTurnComplete: () => events.push("turnComplete"),
      onInterrupted: () => events.push("interrupted"),
      onPersistenceError: (message) => persistenceErrors.push(message),
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
  return {controller, sockets, requests, audio, events, errors, persistenceErrors}
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

function completeTurn(h: ReturnType<typeof harness>, input = "hello", output = "hi"): void {
  h.sockets.at(-1)!.message({
    serverContent: {
      inputTranscription: {text: input},
      outputTranscription: {text: output},
      turnComplete: true,
    },
  })
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
    expect(h.requests.filter((request) => request.url.endsWith("/sitting-1/end"))).toHaveLength(1)
  })

  test("retries one stale-bootstrap conflict", async () => {
    const h = harness({
      startResults: [
        {status: 409, body: {detail: {code: "mentra_history_changed"}}},
        {
          status: 200,
          body: {
            session_id: "sitting-2",
            next_transcript_sequence: 42,
            ephemeral_token: "ephemeral/retry",
            websocket: {
              api_version: "v1alpha",
              method: "BidiGenerateContentConstrained",
              input_audio_rate_hz: 16000,
              output_audio_rate_hz: 24000,
            },
            lease_seconds: 90,
          },
        },
      ],
    })

    await start(h)

    expect(h.requests.filter((request) => request.url.endsWith("/session/start"))).toHaveLength(2)
    await h.controller.stop()
    expect(h.requests.some((request) => request.url.endsWith("/sitting-2/end"))).toBe(true)
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
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/transcripts/append")))
    const append = h.requests.find((request) => request.url.endsWith("/transcripts/append"))!
    expect(append.body).toEqual({
      user_id: "Test User",
      soul_id: "Test Soul",
      events: [
        {
          event_id: "sitting-1:41",
          sequence: 41,
          event_kind: "transcript",
          role: "user",
          content: "hello",
          status: "complete",
        },
        {
          event_id: "sitting-1:42",
          sequence: 42,
          event_kind: "transcript",
          role: "assistant",
          content: "hi",
          status: "complete",
        },
      ],
    })
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

  test("finalizes interrupted text once and does not leak it into the next turn", async () => {
    const h = harness()
    await start(h)
    h.sockets[0].message({serverContent: {inputTranscription: {text: "first question"}}})
    h.sockets[0].message({serverContent: {outputTranscription: {text: "partial answer"}}})
    h.sockets[0].message({serverContent: {interrupted: true}})
    h.sockets[0].message({serverContent: {turnComplete: true}})
    completeTurn(h, "second question", "second answer")

    await waitFor(() => h.requests.some((request) => request.url.endsWith("/transcripts/append")))
    const appends = h.requests.filter((request) => request.url.endsWith("/transcripts/append"))
    expect(appends[0].body.events.map((event: any) => [event.content, event.status])).toEqual([
      ["first question", "complete"],
      ["partial answer", "interrupted"],
      ["second question", "complete"],
      ["second answer", "complete"],
    ])
    expect(h.events).toEqual(["interrupted", "turnComplete", "turnComplete"])
    await h.controller.stop()
  })

  test("completed barge-in input counts toward the reflection gate", async () => {
    const h = harness()
    await start(h)
    h.sockets[0].message({serverContent: {inputTranscription: {text: "first question"}}})
    h.sockets[0].message({serverContent: {outputTranscription: {text: "partial answer"}}})
    h.sockets[0].message({serverContent: {interrupted: true}})
    h.sockets[0].message({serverContent: {turnComplete: true}})
    completeTurn(h, "second question", "second answer")
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/transcripts/append")))

    const stopping = h.controller.stop(true)
    await waitFor(() => h.sockets[0].sent.some((value) => JSON.parse(value).clientContent))
    h.sockets[0].message({serverContent: {outputTranscription: {text: "NO_SUMMARY"}, turnComplete: true}})
    await stopping
  })

  test("fails loud when a completed turn lacks either transcript side", async () => {
    const h = harness()
    await start(h)
    h.sockets[0].message({serverContent: {inputTranscription: {text: "only one side"}, turnComplete: true}})
    expect(h.errors).toEqual(["Gemini completed a turn without both transcriptions"])
    expect(h.requests.some((request) => request.url.endsWith("/transcripts/append"))).toBe(false)
    await h.controller.stop()
  })

  test("retains a failed append and retries the whole contiguous queue on the next turn", async () => {
    const h = harness({appendStatuses: [503, 200]})
    await start(h)
    completeTurn(h, "one", "answer one")
    await waitFor(() => h.persistenceErrors.length === 1)
    completeTurn(h, "two", "answer two")
    await waitFor(() => h.persistenceErrors.at(-1) === null)

    const appends = h.requests.filter((request) => request.url.endsWith("/transcripts/append"))
    expect(appends.map((request) => request.body.events.length)).toEqual([2, 4])
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("drains a retained queue in server-sized batches", async () => {
    const h = harness({appendStatuses: [503, 200, 200]})
    await start(h)
    completeTurn(h, "one", "answer one")
    await waitFor(() => h.persistenceErrors.length === 1)
    for (let turn = 2; turn <= 9; turn++) completeTurn(h, `question ${turn}`, `answer ${turn}`)
    await waitFor(() => h.persistenceErrors.at(-1) === null)

    const appends = h.requests.filter((request) => request.url.endsWith("/transcripts/append"))
    expect(appends.map((request) => request.body.events.length)).toEqual([2, 16, 2])
    expect(appends.every((request) => request.body.events.length <= 16)).toBe(true)
    await h.controller.stop()
  })

  test("treats a transcript contract rejection as fatal", async () => {
    const h = harness({appendStatuses: [409]})
    await start(h)
    completeTurn(h)
    await waitFor(() => h.errors.length === 1)
    expect(h.errors).toEqual(["OpenAlma transcript append failed (409)"])
    await h.controller.stop()
    expect(h.persistenceErrors.includes(null)).toBe(false)
  })

  test("final Stop failure preserves an honest unsaved-transcript warning", async () => {
    const h = harness({appendStatuses: [503, 503]})
    await start(h)
    completeTurn(h)
    await waitFor(() => h.persistenceErrors.length === 1)
    await h.controller.stop()
    expect(h.persistenceErrors.at(-1)).toBe("Transcript sync failed; last turns were not saved")
    expect(h.requests.filter((request) => request.url.endsWith("/sitting-1/end"))).toHaveLength(1)
  })

  test("Stop persists proven partial text as interrupted before End", async () => {
    const h = harness()
    await start(h)
    h.sockets[0].message({serverContent: {inputTranscription: {text: "partial question"}}})
    h.sockets[0].message({serverContent: {outputTranscription: {text: "partial answer"}}})
    await h.controller.stop()

    const append = h.requests.find((request) => request.url.endsWith("/transcripts/append"))!
    expect(append.body.events.map((event: any) => [event.content, event.status])).toEqual([
      ["partial question", "interrupted"],
      ["partial answer", "interrupted"],
    ])
    expect(h.requests.findIndex((request) => request.url.endsWith("/transcripts/append"))).toBeLessThan(
      h.requests.findIndex((request) => request.url.endsWith("/end")),
    )
  })

  test("graceful Stop skips reflection while a normal turn is unfinished", async () => {
    const h = harness()
    await start(h)
    completeTurn(h, "one", "answer one")
    completeTurn(h, "two", "answer two")
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/transcripts/append")))
    h.sockets[0].message({serverContent: {inputTranscription: {text: "partial question"}}})
    h.sockets[0].message({serverContent: {outputTranscription: {text: "partial answer"}}})

    await h.controller.stop(true)
    expect(h.sockets[0].sent.some((value) => JSON.parse(value).clientContent)).toBe(false)
    const events = h.requests
      .filter((request) => request.url.endsWith("/transcripts/append"))
      .flatMap((request) => request.body.events)
    expect(events.slice(-2).map((event: any) => event.status)).toEqual(["interrupted", "interrupted"])
  })

  test("graceful Stop plays and persists one bounded reflection", async () => {
    const h = harness()
    await start(h)
    completeTurn(h, "one", "answer one")
    completeTurn(h, "two", "answer two")
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/transcripts/append")))

    const stopping = h.controller.stop(true)
    await waitFor(() => h.sockets[0].sent.some((value) => JSON.parse(value).clientContent))
    h.sockets[0].message({
      serverContent: {
        modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]},
        outputTranscription: {text: "I noticed warmth."},
        turnComplete: true,
      },
    })
    await stopping

    const appends = h.requests.filter((request) => request.url.endsWith("/transcripts/append"))
    expect(appends.at(-1)?.body.events).toEqual([
      {
        event_id: "sitting-1:45",
        sequence: 45,
        event_kind: "sitting_summary",
        role: "assistant",
        content: "I noticed warmth.",
      },
    ])
    expect(h.audio.at(-1)).toBe("AAAAAA==")
    expect(h.requests.filter((request) => request.url.endsWith("/sitting-1/end"))).toHaveLength(1)
  })

  test("graceful Stop may speak NO_SUMMARY without persisting it", async () => {
    const h = harness()
    await start(h)
    completeTurn(h, "one", "answer one")
    completeTurn(h, "two", "answer two")
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/transcripts/append")))

    const stopping = h.controller.stop(true)
    await waitFor(() => h.sockets[0].sent.some((value) => JSON.parse(value).clientContent))
    h.sockets[0].message({
      serverContent: {
        modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]},
        outputTranscription: {text: "NO_SUMMARY"},
        turnComplete: true,
      },
    })
    await stopping

    const events = h.requests
      .filter((request) => request.url.endsWith("/transcripts/append"))
      .flatMap((request) => request.body.events)
    expect(events.some((event: any) => event.event_kind === "sitting_summary")).toBe(false)
    expect(h.audio.at(-1)).toBe("AAAAAA==")
  })

  test("unexpected input during reflection ends reflection immediately", async () => {
    const h = harness()
    await start(h)
    completeTurn(h, "one", "answer one")
    completeTurn(h, "two", "answer two")
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/transcripts/append")))

    const stopping = h.controller.stop(true)
    await waitFor(() => h.sockets[0].sent.some((value) => JSON.parse(value).clientContent))
    h.sockets[0].message({serverContent: {inputTranscription: {text: "unexpected"}}})
    await stopping

    expect(h.errors).toContain("Gemini returned input transcription during reflection")
    expect(h.requests.filter((request) => request.url.endsWith("/end"))).toHaveLength(1)
  })

  test("socket close during reflection discards partial private reflection", async () => {
    const h = harness()
    await start(h)
    completeTurn(h, "one", "answer one")
    completeTurn(h, "two", "answer two")
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/transcripts/append")))

    const stopping = h.controller.stop(true)
    await waitFor(() => h.sockets[0].sent.some((value) => JSON.parse(value).clientContent))
    h.sockets[0].message({serverContent: {outputTranscription: {text: "private partial"}}})
    h.sockets[0].close()
    await stopping

    const events = h.requests
      .filter((request) => request.url.endsWith("/transcripts/append"))
      .flatMap((request) => request.body.events)
    expect(events.some((event: any) => event.content === "private partial")).toBe(false)
    expect(h.sockets).toHaveLength(1)
  })

  test("resumes once with the latest private handle", async () => {
    const h = harness()
    await start(h)
    h.sockets[0].message({serverContent: {inputTranscription: {text: "before drop"}}})
    h.sockets[0].message({serverContent: {outputTranscription: {text: "partial answer"}}})
    h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
    h.sockets[0].error()
    await waitFor(() => h.sockets.length === 2)
    expect(() => h.controller.sendAudio("AAAA")).not.toThrow()
    h.sockets[1].open()
    expect(JSON.parse(h.sockets[1].sent[0])).toEqual({
      setup: {sessionResumption: {handle: "private-handle"}},
    })
    h.sockets[1].message({setupComplete: {}})
    completeTurn(h, "after resume", "fresh answer")
    await waitFor(
      () =>
        h.requests
          .filter((request) => request.url.endsWith("/transcripts/append"))
          .flatMap((request) => request.body.events).length === 4,
    )
    const events = h.requests
      .filter((request) => request.url.endsWith("/transcripts/append"))
      .flatMap((request) => request.body.events)
    expect(events.map((event: any) => [event.content, event.status])).toEqual([
      ["before drop", "interrupted"],
      ["partial answer", "interrupted"],
      ["after resume", "complete"],
      ["fresh answer", "complete"],
    ])
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
