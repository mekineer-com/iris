import {describe, expect, spyOn, test} from "bun:test"

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
  failAtSendCount: number | null = null
  closeAtSendCount: number | null = null
  private listeners: Record<string, Array<(event: any) => void>> = {}

  addEventListener(type: string, listener: (event: any) => void): void {
    ;(this.listeners[type] ??= []).push(listener)
  }

  send(data: string): void {
    if (this.failAtSendCount === this.sent.length) throw new Error("socket send failed")
    if (this.closeAtSendCount === this.sent.length) this.readyState = 3
    if (this.readyState !== 1) return
    this.sent.push(data)
  }

  open(): void {
    this.readyState = 1
    this.emit("open", {})
  }

  message(value: unknown): void {
    this.emit("message", {
      data: typeof value === "string" || value instanceof ArrayBuffer ? value : JSON.stringify(value),
    })
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

class FakeStorage {
  values = new Map<string, string>()
  setCalls = 0
  setGate: Promise<void> | null = null

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null
  }

  async set(key: string, value: string): Promise<void> {
    this.setCalls += 1
    if (this.setGate) await this.setGate
    this.values.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }
}

function harness(
  options: {
    heartbeatMs?: number
    setupTimeoutMs?: number
    heartbeatStatus?: number
    heartbeatThrows?: boolean
    startGate?: Promise<void>
    startStatus?: number
    startBody?: unknown
    startResults?: Array<{status: number; body: unknown}>
    tokenGate?: Promise<void>
    tokenStatuses?: number[]
    leaseSeconds?: number
    appendStatuses?: number[]
    appendGates?: Promise<void>[]
    snapshotStatus?: number
    snapshotGate?: Promise<void>
    finalizeStatuses?: number[]
    recallGate?: Promise<void>
    recallStatus?: number
    recallBody?: unknown
    storage?: FakeStorage
    warningSeconds?: number
  } = {},
) {
  const sockets: FakeSocket[] = []
  const socketUrls: string[] = []
  const requests: Array<{url: string; body: any; authorization: string | null}> = []
  const audio: string[] = []
  const events: string[] = []
  const errors: string[] = []
  const persistenceErrors: Array<string | null> = []
  const reconnecting: boolean[] = []
  const usage: number[] = []
  let durationWarnings = 0
  const appendStatuses = [...(options.appendStatuses ?? [])]
  const appendGates = [...(options.appendGates ?? [])]
  const startResults = [...(options.startResults ?? [])]
  const tokenStatuses = [...(options.tokenStatuses ?? [])]
  const finalizeStatuses = [...(options.finalizeStatuses ?? [])]
  let refreshedTokens = 0
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
          session_warning_seconds: options.warningSeconds ?? 0,
        },
        {status: result?.status ?? options.startStatus ?? 200},
      )
    }
    if (url.endsWith("/token")) {
      if (options.tokenGate) await options.tokenGate
      refreshedTokens += 1
      return Response.json(
        {ephemeral_token: `ephemeral/refresh-${refreshedTokens}`},
        {status: tokenStatuses.shift() ?? 200},
      )
    }
    if (url.endsWith("/heartbeat")) {
      if (options.heartbeatThrows) throw new Error("fictional network miss")
      return Response.json({ok: true}, {status: options.heartbeatStatus ?? 200})
    }
    if (url.endsWith("/recall")) {
      if (options.recallGate) await options.recallGate
      return Response.json(
        options.recallBody ?? {ok: true, context: "A compact fictional memory.", retrieve_ms: 123},
        {status: options.recallStatus ?? 200},
      )
    }
    if (url.endsWith("/transcripts/append")) {
      await appendGates.shift()
      return Response.json(
        {ok: true, ack_sequence: body.events.at(-1)?.sequence ?? 0},
        {status: appendStatuses.shift() ?? 200},
      )
    }
    if (url.endsWith("/snapshot/finalize")) {
      return Response.json({ok: true}, {status: finalizeStatuses.shift() ?? 200})
    }
    if (url.endsWith("/snapshot")) {
      if (options.snapshotGate) await options.snapshotGate
      const extension = body.mime_type === "image/jpeg" ? "jpg" : "png"
      return Response.json(
        {ok: true, media_ref: `mentra_media/test-phone/${body.image_id}.${extension}`},
        {status: options.snapshotStatus ?? 200},
      )
    }
    return Response.json({ok: true})
  }
  const controller = new GeminiLiveController(
    CONFIG,
    {
      onAudio: (data) => audio.push(data),
      onTurnComplete: (finalResponse) => events.push(finalResponse ? "turnComplete" : "toolBoundary"),
      onInterrupted: () => events.push("interrupted"),
      onReconnecting: (value) => reconnecting.push(value),
      onUsage: (totalTokens) => usage.push(totalTokens),
      onDurationWarning: () => {
        durationWarnings += 1
      },
      onPersistenceError: (message) => persistenceErrors.push(message),
      onError: (error) => errors.push(error.message),
    },
    {
      fetchFn: fetchFn as typeof fetch,
      openSocket: (url) => {
        const socket = new FakeSocket()
        sockets.push(socket)
        socketUrls.push(url)
        return socket
      },
      heartbeatMs: options.heartbeatMs,
      setupTimeoutMs: options.setupTimeoutMs,
      storage: options.storage,
    },
  )
  return {
    controller,
    sockets,
    socketUrls,
    requests,
    audio,
    events,
    errors,
    persistenceErrors,
    reconnecting,
    usage,
    get durationWarnings() {
      return durationWarnings
    },
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 0))
  expect(predicate()).toBe(true)
}

async function start(h: ReturnType<typeof harness>, mode: "continuous" | "manual" = "continuous"): Promise<void> {
  const starting = h.controller.start(mode)
  await waitFor(() => h.sockets.length === 1)
  h.sockets[0].open()
  expect(JSON.parse(h.sockets[0].sent[0])).toEqual({setup: {sessionResumption: {}}})
  h.sockets[0].message(new TextEncoder().encode(JSON.stringify({setupComplete: {}})).buffer)
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
  test("snapshots, sends, journals, acknowledges, then finalizes one image", async () => {
    const storage = new FakeStorage()
    const h = harness({storage})
    await start(h)

    await h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    expect(h.requests.find((request) => request.url.endsWith("/snapshot"))?.body).toEqual({
      user_id: "Test User",
      soul_id: "Test Soul",
      image_id: "image-1",
      mime_type: "image/png",
      data: "AQID",
    })
    expect(JSON.parse(h.sockets[0].sent.at(-1)!)).toEqual({
      clientContent: {
        turns: [{role: "user", parts: [
          {inlineData: {data: "AQID", mimeType: "image/png"}},
          {text: "Describe this image."},
        ]}],
        turnComplete: true,
      },
    })

    h.sockets[0].message({serverContent: {outputTranscription: {text: "A fictional blue square."}, turnComplete: true}})
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot/finalize")))
    const appended = h.requests.filter((request) => request.url.endsWith("/transcripts/append"))
      .flatMap((request) => request.body.events)
    expect(appended).toContainEqual({
      event_id: "sitting-1:41",
      sequence: 41,
      event_kind: "image",
      role: "user",
      content: "Shared a photo.",
      media_ref: "mentra_media/test-phone/image-1.png",
    })
    expect(appended).toContainEqual({
      event_id: "sitting-1:42",
      sequence: 42,
      event_kind: "transcript",
      role: "assistant",
      content: "A fictional blue square.",
      status: "complete",
    })
    expect(h.requests.find((request) => request.url.endsWith("/snapshot/finalize"))?.body).toEqual({
      user_id: "Test User",
      soul_id: "Test Soul",
      image_id: "image-1",
      caption: "A fictional blue square.",
    })
    await h.controller.stop()
  })

  test("does not send Gemini when durable snapshot fails", async () => {
    const h = harness({storage: new FakeStorage(), snapshotStatus: 503})
    await start(h)
    await expect(h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})).rejects.toThrow(
      "OpenAlma snapshot failed (503)",
    )
    expect(h.sockets[0].sent).toHaveLength(1)
    await h.controller.stop()
  })

  test("retries the same durable image after provider send failure", async () => {
    const h = harness({storage: new FakeStorage()})
    await start(h)
    const image = {imageId: "image-1", mimeType: "image/png" as const, data: "AQID"}
    h.sockets[0].failAtSendCount = 1
    await expect(h.controller.sendImage(image)).rejects.toThrow("Gemini image send failed")
    h.sockets[0].failAtSendCount = null
    await h.controller.sendImage(image)
    expect(h.requests.filter((request) => request.url.endsWith("/snapshot"))).toHaveLength(2)
    expect(h.sockets[0].sent.filter((value) => JSON.parse(value).clientContent)).toHaveLength(1)
    await h.controller.stop()
  })

  test("allows a retake after provider send failure", async () => {
    const h = harness({storage: new FakeStorage()})
    await start(h)
    h.sockets[0].failAtSendCount = 1
    await expect(h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"}))
      .rejects.toThrow("Gemini image send failed")

    h.sockets[0].failAtSendCount = null
    await h.controller.sendImage({imageId: "image-2", mimeType: "image/png", data: "AQID"})

    expect(h.sockets[0].sent.filter((value) => JSON.parse(value).clientContent)).toHaveLength(1)
    await h.controller.stop()
  })

  test("Stop during snapshot never sends the stale image turn", async () => {
    let release!: () => void
    const snapshotGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness({storage: new FakeStorage(), snapshotGate})
    await start(h)
    const sending = h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot")))
    await h.controller.stop()
    release()
    await expect(sending).rejects.toThrow("Photo send cancelled")
    expect(h.sockets[0].sent.filter((value) => JSON.parse(value).clientContent)).toHaveLength(0)
  })

  test("retains image finalization until the caption transcript is acknowledged", async () => {
    let releaseImage!: () => void
    let releaseCaption!: () => void
    const imageGate = new Promise<void>((resolve) => {
      releaseImage = resolve
    })
    const captionGate = new Promise<void>((resolve) => {
      releaseCaption = resolve
    })
    const h = harness({storage: new FakeStorage(), appendGates: [imageGate, captionGate]})
    await start(h)
    await h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    await waitFor(() => h.requests.filter((request) => request.url.endsWith("/transcripts/append")).length === 1)
    releaseImage()
    await new Promise((resolve) => setTimeout(resolve, 0))
    h.sockets[0].message({serverContent: {outputTranscription: {text: "A fictional blue square."}, turnComplete: true}})
    await waitFor(() => h.requests.filter((request) => request.url.endsWith("/transcripts/append")).length === 2)
    expect(h.requests.some((request) => request.url.endsWith("/snapshot/finalize"))).toBe(false)
    releaseCaption()
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot/finalize")))
    await h.controller.stop()
  })

  test("uses the image response as its caption when the user also asks a question", async () => {
    const h = harness({storage: new FakeStorage()})
    await start(h)
    await h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    h.sockets[0].message({serverContent: {
      inputTranscription: {text: "What do you see?"},
      outputTranscription: {text: "I see a fictional blue square."},
      turnComplete: true,
    }})
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot/finalize")))

    expect(h.requests.find((request) => request.url.endsWith("/snapshot/finalize"))?.body.caption).toBe(
      "I see a fictional blue square.",
    )
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("Stop during a photo description reports the photo instead of transcript failure", async () => {
    const h = harness({storage: new FakeStorage()})
    await start(h)
    await h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    h.sockets[0].message({serverContent: {outputTranscription: {text: "A partial description."}}})

    await h.controller.stop()

    expect(h.errors).toEqual([])
    expect(h.persistenceErrors).toContain("Photo description was interrupted; the photo remains pending")
    expect(h.persistenceErrors).not.toContain("Transcript sync failed; pending turns remain saved on this device")
  })

  test("does not treat later speech as the image turn while finalization retries", async () => {
    const h = harness({storage: new FakeStorage(), finalizeStatuses: Array(10).fill(503)})
    await start(h)
    await h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    h.sockets[0].message({serverContent: {
      outputTranscription: {text: "A fictional blue square."},
      turnComplete: true,
    }})
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot/finalize")))

    completeTurn(h, "A later question.", "A later answer.")
    await waitFor(() => h.requests.filter((request) => request.url.endsWith("/transcripts/append"))
      .some((request) => request.body.events.some((event: any) => event.content === "A later question.")))
    await h.controller.stop()

    expect(h.requests.filter((request) => request.url.endsWith("/snapshot/finalize"))
      .every((request) => request.body.caption === "A fictional blue square.")).toBe(true)
    expect(h.errors).toEqual([])
  })

  test("does not bind an older tool continuation as the image caption", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness({storage: new FakeStorage(), recallGate: gate})
    await start(h)
    h.sockets[0].message({toolCall: {
      functionCalls: [{id: "before-image", name: "recall_memory", args: {query: "older question"}}],
    }})
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/recall")))
    await h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    release()
    await waitFor(() => h.sockets[0].sent.some((value) => JSON.parse(value).toolResponse))
    h.sockets[0].message({serverContent: {
      outputTranscription: {text: "The older tool answer."},
      turnComplete: true,
    }})
    h.sockets[0].message({serverContent: {
      outputTranscription: {text: "The photo shows a fictional blue square."},
      turnComplete: true,
    }})
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot/finalize")))

    expect(h.requests.find((request) => request.url.endsWith("/snapshot/finalize"))?.body.caption).toBe(
      "The photo shows a fictional blue square.",
    )
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("hydrates an uncaptioned image for same-id retry without duplicating its event", async () => {
    const storage = new FakeStorage()
    storage.values.set("openalma:gemini-session-v1", JSON.stringify({
      version: 1,
      scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
      resumption: null,
      pendingTranscripts: [{
        event_id: "old-sitting:41",
        sequence: 41,
        event_kind: "image",
        role: "user",
        content: "Shared a photo.",
        media_ref: "mentra_media/test-phone/image-1.png",
      }],
      pendingImage: {
        imageId: "image-1",
        mediaRef: "mentra_media/test-phone/image-1.png",
        providerSent: true,
        captureAfterCurrent: false,
        generation: 1,
        sessionId: "old-sitting",
        imageSequence: 41,
      },
    }))
    const h = harness({storage})
    await start(h)

    await h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    h.sockets[0].message({serverContent: {
      outputTranscription: {text: "A fictional blue square."},
      turnComplete: true,
    }})
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot/finalize")))
    const imageEvents = h.requests.filter((request) => request.url.endsWith("/transcripts/append"))
      .flatMap((request) => request.body.events)
      .filter((event) => event.event_kind === "image")

    expect(new Set(imageEvents.map((event) => event.event_id))).toEqual(new Set(["sitting-1:41"]))
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("does not bind an already-active speech turn as the image caption", async () => {
    const h = harness({storage: new FakeStorage()})
    await start(h)
    h.sockets[0].message({serverContent: {
      inputTranscription: {text: "Current user turn."},
      outputTranscription: {text: "Current answer."},
    }})
    await h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    h.sockets[0].message({serverContent: {turnComplete: true}})
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.requests.some((request) => request.url.endsWith("/snapshot/finalize"))).toBe(false)

    h.sockets[0].message({serverContent: {
      outputTranscription: {text: "The photo shows a fictional blue square."},
      turnComplete: true,
    }})
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot/finalize")))
    expect(h.requests.find((request) => request.url.endsWith("/snapshot/finalize"))?.body.caption).toBe(
      "The photo shows a fictional blue square.",
    )
    await h.controller.stop()
  })

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

  test("sends one buffered Manual activity in order", async () => {
    const h = harness()
    await start(h, "manual")

    h.controller.sendActivity(["AAAA", "BBBB"])

    expect(h.requests[0].body.mode).toBe("manual")
    expect(h.sockets[0].sent.slice(1).map((value) => JSON.parse(value))).toEqual([
      {realtimeInput: {activityStart: {}}},
      {realtimeInput: {audio: {data: "AAAA", mimeType: "audio/pcm;rate=16000"}}},
      {realtimeInput: {audio: {data: "BBBB", mimeType: "audio/pcm;rate=16000"}}},
      {realtimeInput: {activityEnd: {}}},
    ])
    await h.controller.stop()
  })

  test("preserves a pre-send Manual take but reports partial transmission", async () => {
    const h = harness()
    await start(h, "manual")
    h.sockets[0].readyState = 0
    expect(() => h.controller.sendActivity(["AAAA"])).toThrow("Gemini socket is not ready")
    expect(h.errors).toEqual([])

    h.sockets[0].readyState = 1
    h.sockets[0].failAtSendCount = 3
    expect(() => h.controller.sendActivity(["AAAA", "BBBB"])).toThrow(
      "Gemini manual activity send failed",
    )
    expect(h.errors).toEqual(["Gemini manual activity send failed"])
    await h.controller.stop()
  })

  test("fails when the socket silently closes during a Manual activity", async () => {
    const h = harness()
    await start(h, "manual")
    h.sockets[0].closeAtSendCount = 3

    expect(() => h.controller.sendActivity(["AAAA", "BBBB"])).toThrow(
      "Gemini manual activity send failed",
    )
    expect(h.errors).toEqual(["Gemini manual activity send failed"])
    expect(h.sockets[0].sent.map((value) => JSON.parse(value)).at(-1)).toEqual({
      realtimeInput: {audio: {data: "AAAA", mimeType: "audio/pcm;rate=16000"}},
    })
    await h.controller.stop()
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
            session_warning_seconds: 0,
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
    h.sockets[0].message({serverContent: {inputTranscription: {text: "hel"}}})
    h.sockets[0].message({
      serverContent: {
        modelTurn: {
          parts: [{inlineData: {data: "AAAAAA=="}}, {text: "ignored"}, {inlineData: {data: "AAAAAA=="}}],
        },
        inputTranscription: {text: "lo"},
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

  test("processes audio while recall is pending and preserves tool-boundary speech", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness({recallGate: gate})
    await start(h)

    h.sockets[0].message({
      serverContent: {
        modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]},
        inputTranscription: {text: "remember the beacon"},
        turnComplete: true,
      },
      toolCall: {
        functionCalls: [{id: "call-1", name: "recall_memory", args: {query: "beacon"}}],
      },
    })
    expect(h.events).toEqual(["toolBoundary"])
    expect(h.audio).toEqual(["AAAAAA=="])
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/recall")))
    const recall = h.requests.find((request) => request.url.endsWith("/recall"))!
    expect(recall.body).toEqual({user_id: "Test User", soul_id: "Test Soul", query: "beacon"})
    expect(recall.authorization).toBe("Bearer fictional-bearer")

    h.sockets[0].message({serverContent: {modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}}})
    expect(h.audio).toEqual(["AAAAAA==", "AAAAAA=="])
    expect(h.sockets[0].sent.some((value) => JSON.parse(value).toolResponse)).toBe(false)

    release()
    await waitFor(() => h.sockets[0].sent.some((value) => JSON.parse(value).toolResponse))
    expect(JSON.parse(h.sockets[0].sent.find((value) => JSON.parse(value).toolResponse)!)).toEqual({
      toolResponse: {
        functionResponses: [{
          id: "call-1",
          name: "recall_memory",
          response: {result: "A compact fictional memory."},
          scheduling: "SILENT",
        }],
      },
    })

    h.sockets[0].message({
      serverContent: {outputTranscription: {text: "I remembered it."}, turnComplete: true},
    })
    completeTurn(h, "ordinary follow-up", "ordinary answer")
    h.sockets[0].message({
      serverContent: {outputTranscription: {text: "stale license"}, turnComplete: true},
    })
    await waitFor(
      () => h.requests
        .filter((request) => request.url.endsWith("/transcripts/append"))
        .flatMap((request) => request.body.events).length === 4,
    )
    const events = h.requests
      .filter((request) => request.url.endsWith("/transcripts/append"))
      .flatMap((request) => request.body.events)
    expect(events.map((event: any) => [event.role, event.content, event.status])).toEqual([
      ["user", "remember the beacon", "complete"],
      ["assistant", "I remembered it.", "complete"],
      ["user", "ordinary follow-up", "complete"],
      ["assistant", "ordinary answer", "complete"],
    ])
    expect(h.errors).toEqual(["Gemini completed a turn without both transcriptions"])
    await h.controller.stop()
  })

  test("temporary recall failure is SILENT and nonfatal", async () => {
    for (const status of [429, 500, 502]) {
      const h = harness({recallStatus: status, recallBody: {detail: "private upstream detail"}})
      await start(h)
      h.sockets[0].message({
        toolCall: {
          functionCalls: [{id: `call-${status}`, name: "recall_memory", args: {query: "private query"}}],
        },
      })

      await waitFor(() => h.sockets[0].sent.some((value) => JSON.parse(value).toolResponse))
      const response = JSON.parse(h.sockets[0].sent.find((value) => JSON.parse(value).toolResponse)!)
      expect(response.toolResponse.functionResponses[0]).toMatchObject({
        response: {result: "Memory recall is temporarily unavailable."},
        scheduling: "SILENT",
      })
      expect(h.persistenceErrors).toContain("Memory recall unavailable; voice is continuing")
      expect(JSON.stringify({response, errors: h.errors, persistenceErrors: h.persistenceErrors})).not.toContain(
        "private",
      )
      expect(h.errors).toEqual([])
      await h.controller.stop()
    }
  })

  test("recall scope, internal, and config failures are fatal without exposing the query", async () => {
    for (const status of [404, 503]) {
      const h = harness({recallStatus: status, recallBody: {detail: "private scope detail"}})
      await start(h)
      h.sockets[0].message({
        toolCall: {
          functionCalls: [{id: `call-${status}`, name: "recall_memory", args: {query: "private query"}}],
        },
      })

      await waitFor(() => h.errors.length === 1)
      expect(h.errors).toEqual([`OpenAlma memory recall failed (${status})`])
      expect(h.sockets[0].sent.some((value) => JSON.parse(value).toolResponse)).toBe(false)
      expect(JSON.stringify(h.errors)).not.toContain("private")
      await h.controller.stop()
    }
  })

  test("cancelled recall never sends a late tool response", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness({recallGate: gate})
    await start(h)
    h.sockets[0].message({
      toolCall: {
        functionCalls: [{id: "call-3", name: "recall_memory", args: {query: "cancel me"}}],
      },
    })
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/recall")))
    h.sockets[0].message({toolCallCancellation: {ids: ["call-3"]}})
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(h.sockets[0].sent.some((value) => JSON.parse(value).toolResponse)).toBe(false)
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("answers batched recalls by provider call ID", async () => {
    const h = harness()
    await start(h)
    h.sockets[0].message({
      toolCall: {
        functionCalls: [
          {id: "batch-1", name: "recall_memory", args: {query: "first"}},
          {id: "batch-2", name: "recall_memory", args: {query: "second"}},
        ],
      },
    })

    await waitFor(
      () => h.sockets[0].sent.filter((value) => JSON.parse(value).toolResponse).length === 2,
    )
    const ids = h.sockets[0].sent
      .map((value) => JSON.parse(value).toolResponse?.functionResponses?.[0]?.id)
      .filter(Boolean)
    expect(ids).toEqual(["batch-1", "batch-2"])
    expect(h.requests.filter((request) => request.url.endsWith("/recall")).map((request) => request.body.query))
      .toEqual(["first", "second"])
    await h.controller.stop()
  })

  test("pending recall follows unexpected-close and GoAway replacements", async () => {
    for (const cause of ["close", "goAway"] as const) {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const h = harness({recallGate: gate})
      await start(h)
      h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
      h.sockets[0].message({
        toolCall: {
          functionCalls: [{id: "call-4", name: "recall_memory", args: {query: "resume"}}],
        },
      })
      await waitFor(() => h.requests.some((request) => request.url.endsWith("/recall")))
      if (cause === "close") h.sockets[0].error()
      else h.sockets[0].message({goAway: {timeLeft: "0.1s"}})
      await waitFor(() => h.sockets.length === 2)
      h.sockets[1].open()
      h.sockets[1].message({setupComplete: {}})
      release()
      await waitFor(() => h.sockets[1].sent.some((value) => JSON.parse(value).toolResponse))

      expect(h.sockets[0].sent.some((value) => JSON.parse(value).toolResponse)).toBe(false)
      expect(JSON.parse(h.sockets[1].sent.find((value) => JSON.parse(value).toolResponse)!))
        .toEqual({
          toolResponse: {
            functionResponses: [{
              id: "call-4",
              name: "recall_memory",
              response: {result: "A compact fictional memory."},
              scheduling: "SILENT",
            }],
          },
        })
      expect(h.errors).toEqual([])
      await h.controller.stop()
    }
  })

  test("graceful reflection discards a late recall result", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness({recallGate: gate})
    await start(h)
    completeTurn(h, "one", "answer one")
    completeTurn(h, "two", "answer two")
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/transcripts/append")))
    h.sockets[0].message({
      toolCall: {
        functionCalls: [{id: "call-stop", name: "recall_memory", args: {query: "late"}}],
      },
    })
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/recall")))

    const stopping = h.controller.stop(true)
    await waitFor(() => h.sockets[0].sent.some((value) => JSON.parse(value).clientContent))
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    h.sockets[0].message({
      serverContent: {outputTranscription: {text: "NO_SUMMARY"}, turnComplete: true},
    })
    await stopping

    expect(h.sockets[0].sent.some((value) => JSON.parse(value).toolResponse)).toBe(false)
    expect(h.errors).toEqual([])
  })

  test("malformed and ordinary one-sided turns still fail loud", async () => {
    const unknown = harness()
    await start(unknown)
    unknown.sockets[0].message({
      toolCall: {functionCalls: [{id: "call-x", name: "other_tool", args: {query: "x"}}]},
    })
    expect(unknown.errors).toEqual(["Gemini returned malformed recall_memory call"])
    await unknown.controller.stop()

    const oneSided = harness()
    await start(oneSided)
    oneSided.sockets[0].message({
      serverContent: {inputTranscription: {text: "ordinary input"}, turnComplete: true},
    })
    expect(oneSided.errors).toEqual(["Gemini completed a turn without both transcriptions"])
    await oneSided.controller.stop()

    let release!: () => void
    const pendingGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = harness({recallGate: pendingGate})
    await start(pending)
    pending.sockets[0].message({
      toolCall: {
        functionCalls: [{id: "pending", name: "recall_memory", args: {query: "pending"}}],
      },
    })
    await waitFor(() => pending.requests.some((request) => request.url.endsWith("/recall")))
    pending.sockets[0].message({
      serverContent: {inputTranscription: {text: "ordinary while pending"}, turnComplete: true},
    })
    expect(pending.errors).toEqual(["Gemini completed a turn without both transcriptions"])
    release()
    await pending.controller.stop()
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
    const nodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = "development"
    const consoleInfo = spyOn(console, "info").mockImplementation(() => {})
    const h = harness()
    try {
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
      expect(consoleInfo).toHaveBeenCalledWith(
        expect.stringContaining("provider.interrupted"),
        {audioChunks: 0, inputChars: 14, outputChars: 14},
      )
      expect(consoleInfo).toHaveBeenCalledWith(
        expect.stringContaining("provider.turn_complete"),
        {hasToolCall: false, interrupted: true},
      )
      await h.controller.stop()
    } finally {
      consoleInfo.mockRestore()
      if (nodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = nodeEnv
    }
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

  test("writes the existing outbox journal before transcript append", async () => {
    let release!: () => void
    const storage = new FakeStorage()
    storage.setGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness({storage})
    await start(h)
    completeTurn(h)
    await waitFor(() => storage.setCalls === 1)
    expect(h.requests.some((request) => request.url.endsWith("/transcripts/append"))).toBe(false)
    release()
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/transcripts/append")))
    await h.controller.stop()
  })

  test("hydrates and rebases only the unacknowledged transcript suffix", async () => {
    const storage = new FakeStorage()
    storage.values.set(
      "openalma:gemini-session-v1",
      JSON.stringify({
        version: 1,
        scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
        resumption: {handle: "private-handle", updatedAt: Date.now()},
        pendingTranscripts: [
          {
            event_id: "old-sitting:40",
            sequence: 40,
            event_kind: "transcript",
            role: "user",
            content: "already accepted",
            status: "complete",
          },
          {
            event_id: "old-sitting:41",
            sequence: 41,
            event_kind: "transcript",
            role: "assistant",
            content: "unacknowledged suffix",
            status: "complete",
          },
        ],
      }),
    )
    const h = harness({
      storage,
      startBody: {
        session_id: "replacement-sitting",
        next_transcript_sequence: 41,
        ephemeral_token: "ephemeral/test",
        websocket: {
          api_version: "v1alpha",
          method: "BidiGenerateContentConstrained",
          input_audio_rate_hz: 16000,
          output_audio_rate_hz: 24000,
        },
        lease_seconds: 90,
        session_warning_seconds: 0,
      },
    })
    const starting = h.controller.start()
    await waitFor(() => h.sockets.length === 1)
    h.sockets[0].open()
    expect(JSON.parse(h.sockets[0].sent[0])).toEqual({
      setup: {sessionResumption: {handle: "private-handle"}},
    })
    h.sockets[0].message({setupComplete: {}})
    await starting
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/transcripts/append")))
    const append = h.requests.find((request) => request.url.endsWith("/transcripts/append"))!
    expect(append.body.events).toEqual([
      expect.objectContaining({
        event_id: "replacement-sitting:41",
        sequence: 41,
        content: "unacknowledged suffix",
      }),
    ])
    await waitFor(() => {
      const raw = storage.values.get("openalma:gemini-session-v1")
      return Boolean(raw && JSON.parse(raw).pendingTranscripts.length === 0)
    })
    await h.controller.stop(true)
    expect(storage.values.has("openalma:gemini-session-v1")).toBe(false)
  })

  test("ignores a resumption handle older than the measured token window", async () => {
    const storage = new FakeStorage()
    storage.values.set(
      "openalma:gemini-session-v1",
      JSON.stringify({
        version: 1,
        scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
        resumption: {handle: "expired-handle", updatedAt: Date.now() - 31 * 60 * 1000},
        pendingTranscripts: [],
      }),
    )
    const h = harness({storage})
    await start(h)
    expect(JSON.parse(h.sockets[0].sent[0])).toEqual({setup: {sessionResumption: {}}})
    await h.controller.stop(true)
  })

  test("falls back cold after a stored handle fails setup", async () => {
    const storage = new FakeStorage()
    storage.values.set(
      "openalma:gemini-session-v1",
      JSON.stringify({
        version: 1,
        scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
        resumption: {handle: "private-handle", updatedAt: Date.now()},
        pendingTranscripts: [],
      }),
    )
    const h = harness({storage})
    const starting = h.controller.start()
    await waitFor(() => h.sockets.length === 1)
    h.sockets[0].error()
    await waitFor(() => h.sockets.length === 2)
    h.sockets[1].open()
    expect(JSON.parse(h.sockets[1].sent[0])).toEqual({setup: {sessionResumption: {}}})
    h.sockets[1].message({setupComplete: {}})
    await starting
    expect(storage.values.has("openalma:gemini-session-v1")).toBe(false)
    await h.controller.stop(true)
  })

  test("failed recovery preserves the hydrated handle for Retry", async () => {
    const storage = new FakeStorage()
    storage.values.set(
      "openalma:gemini-session-v1",
      JSON.stringify({
        version: 1,
        scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
        resumption: {handle: "private-handle", updatedAt: Date.now()},
        pendingTranscripts: [],
      }),
    )
    const h = harness({storage})
    const starting = h.controller.start()
    await waitFor(() => h.sockets.length === 1)
    h.sockets[0].error()
    await waitFor(() => h.sockets.length === 2)
    h.sockets[1].error()
    await expect(starting).rejects.toThrow("Gemini socket failed during setup")
    expect(JSON.parse(storage.values.get("openalma:gemini-session-v1")!).resumption.handle).toBe("private-handle")
  })

  test("drops a journal event that mcp would reject", async () => {
    const storage = new FakeStorage()
    storage.values.set(
      "openalma:gemini-session-v1",
      JSON.stringify({
        version: 1,
        scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
        resumption: {handle: "must-not-resume", updatedAt: Date.now()},
        pendingTranscripts: [
          {
            event_id: "old:41",
            sequence: 41,
            event_kind: "transcript",
            role: "user",
            content: "blank status is invalid",
          },
        ],
      }),
    )
    const h = harness({storage})
    await start(h)
    expect(JSON.parse(h.sockets[0].sent[0])).toEqual({setup: {sessionResumption: {}}})
    expect(storage.values.has("openalma:gemini-session-v1")).toBe(false)
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

  test("final Stop failure preserves an honest local-backup warning", async () => {
    const h = harness({appendStatuses: [503, 503]})
    await start(h)
    completeTurn(h)
    await waitFor(() => h.persistenceErrors.length === 1)
    await h.controller.stop()
    expect(h.persistenceErrors.at(-1)).toBe("Transcript sync failed; pending turns remain saved on this device")
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

  test("resumes with the latest private handle and resets only after a completed turn", async () => {
    const h = harness()
    await start(h)
    h.sockets[0].message({serverContent: {inputTranscription: {text: "before drop"}}})
    h.sockets[0].message({serverContent: {outputTranscription: {text: "partial answer"}}})
    h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
    h.sockets[0].error()
    await waitFor(() => h.sockets.length === 2)
    expect(h.events).toContain("interrupted")
    expect(() => h.controller.sendAudio("AAAA")).not.toThrow()
    h.sockets[1].open()
    expect(JSON.parse(h.sockets[1].sent[0])).toEqual({
      setup: {sessionResumption: {handle: "private-handle"}},
    })
    h.sockets[1].message({setupComplete: {}})
    await waitFor(() => h.reconnecting.length === 2)
    expect(h.reconnecting).toEqual([true, false])
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
    await waitFor(() => h.sockets.length === 3)
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("does not loop when the replacement closes before a completed turn", async () => {
    const h = harness()
    await start(h)
    h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
    h.sockets[0].close()
    await waitFor(() => h.sockets.length === 2)
    h.sockets[1].open()
    h.sockets[1].message({setupComplete: {}})
    h.sockets[1].close()
    await waitFor(() => h.errors.length === 1)
    expect(h.sockets).toHaveLength(2)
    expect(h.errors).toEqual(["Gemini replacement socket closed after setup"])
    await h.controller.stop()
  })

  test("keeps one reconnect operation alive while brief network loss blocks setup", async () => {
    const h = harness({setupTimeoutMs: 20})
    await start(h)
    h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
    h.sockets[0].close()
    await waitFor(() => h.sockets.length === 2)
    h.sockets[1].error()
    await waitFor(() => h.sockets.length === 3)
    h.sockets[2].open()
    h.sockets[2].message({setupComplete: {}})
    await waitFor(() => h.reconnecting.length === 2)

    expect(h.reconnecting).toEqual([true, false])
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("Stop during network recovery stays stopped without a late setup error", async () => {
    const h = harness({setupTimeoutMs: 20})
    await start(h)
    h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
    h.sockets[0].close()
    await waitFor(() => h.sockets.length === 2)
    h.sockets[1].error()
    await h.controller.stop()
    await waitFor(() => h.reconnecting.at(-1) === false)

    expect(h.errors).toEqual([])
    expect(h.sockets).toHaveLength(2)
  })

  test("resumable false clears the latest private handle", async () => {
    const h = harness()
    await start(h)
    h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
    h.sockets[0].message({sessionResumptionUpdate: {resumable: false}})
    h.sockets[0].close()
    await waitFor(() => h.errors.length === 1)
    expect(h.sockets).toHaveLength(1)
    await h.controller.stop()
  })

  test("GoAway rotates immediately while idle and fences the old socket", async () => {
    const h = harness()
    await start(h)
    h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
    h.sockets[0].message({goAway: {timeLeft: "50s"}})
    await waitFor(() => h.sockets.length === 2)
    expect(h.sockets[0].readyState).toBe(3)
    expect(h.requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(1)
    expect(h.socketUrls[1]).toContain("access_token=ephemeral%2Frefresh-1")
    expect(h.reconnecting).toEqual([true])
    h.sockets[1].open()
    expect(JSON.parse(h.sockets[1].sent[0])).toEqual({
      setup: {sessionResumption: {handle: "private-handle"}},
    })
    h.sockets[1].message({setupComplete: {}})
    await waitFor(() => h.reconnecting.length === 2)
    expect(h.reconnecting).toEqual([true, false])
    h.sockets[0].message({setupComplete: {}})
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("GoAway waits for an active turn boundary", async () => {
    const h = harness()
    await start(h)
    h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
    h.sockets[0].message({serverContent: {inputTranscription: {text: "active turn"}}})
    h.sockets[0].message({goAway: {timeLeft: "50s"}})
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.sockets).toHaveLength(1)
    h.sockets[0].message({
      serverContent: {outputTranscription: {text: "finished"}, turnComplete: true},
    })
    await waitFor(() => h.sockets.length === 2)
    await h.controller.stop()
  })

  test("GoAway keeps the old socket until transient token mint recovers", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness({setupTimeoutMs: 20, tokenGate: gate, tokenStatuses: [503, 200]})
    await start(h)
    h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
    h.sockets[0].message({goAway: {timeLeft: "50s"}})
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/token")))
    expect(h.sockets[0].readyState).toBe(1)
    release()
    await waitFor(() => h.sockets.length === 2)
    h.sockets[1].open()
    h.sockets[1].message({setupComplete: {}})
    await waitFor(() => h.reconnecting.at(-1) === false)

    expect(h.requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(2)
    expect(h.errors).toEqual([])
    await h.controller.stop(true)
  })

  test("unexpected close clears a pending GoAway before recovery", async () => {
    const h = harness()
    await start(h)
    h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
    h.sockets[0].message({serverContent: {inputTranscription: {text: "active turn"}}})
    h.sockets[0].message({goAway: {timeLeft: "50s"}})
    h.sockets[0].close()
    await waitFor(() => h.sockets.length === 2)
    h.sockets[1].open()
    h.sockets[1].message({setupComplete: {}})
    await waitFor(() => h.reconnecting.at(-1) === false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.sockets).toHaveLength(2)
    expect(h.errors).toEqual([])
    await h.controller.stop(true)
  })

  test("network recovery retries token mint separately from Gemini setup", async () => {
    const h = harness({setupTimeoutMs: 20, tokenStatuses: [503, 503, 200]})
    await start(h)
    h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
    h.sockets[0].close()
    await waitFor(() => h.requests.filter((request) => request.url.endsWith("/token")).length === 3)
    await waitFor(() => h.sockets.length === 2)
    h.sockets[1].open()
    h.sockets[1].message({setupComplete: {}})
    await waitFor(() => h.reconnecting.at(-1) === false)

    expect(h.sockets).toHaveLength(2)
    expect(h.socketUrls[1]).toContain("access_token=ephemeral%2Frefresh-3")
    expect(h.errors).toEqual([])
    await h.controller.stop(true)
  })

  test("network recovery re-mints after Gemini setup failure", async () => {
    const h = harness({setupTimeoutMs: 20})
    await start(h)
    h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
    h.sockets[0].close()
    await waitFor(() => h.sockets.length === 2)
    h.sockets[1].error()
    await waitFor(() => h.sockets.length === 3)
    h.sockets[2].open()
    h.sockets[2].message({setupComplete: {}})
    await waitFor(() => h.reconnecting.at(-1) === false)

    expect(h.requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(2)
    expect(h.socketUrls[1]).toContain("access_token=ephemeral%2Frefresh-1")
    expect(h.socketUrls[2]).toContain("access_token=ephemeral%2Frefresh-2")
    expect(h.errors).toEqual([])
    await h.controller.stop(true)
  })

  test("network recovery stops retrying when the mcp lease expires", async () => {
    const h = harness({setupTimeoutMs: 20, leaseSeconds: 0.05, heartbeatStatus: 503})
    await start(h)
    h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
    h.sockets[0].close()
    await waitFor(() => h.sockets.length === 2)
    h.sockets[1].open()
    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(h.errors).toHaveLength(1)
    expect(h.requests.filter((request) => request.url.endsWith("/token")).length).toBeLessThan(6)
    expect(h.sockets.length).toBeLessThan(7)
    await h.controller.stop(true)
  })

  test("dead lease never opens a replacement with the old token", async () => {
    const h = harness({tokenStatuses: [404]})
    await start(h)
    h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
    h.sockets[0].close()
    await waitFor(() => h.errors.length === 1)

    expect(h.errors).toEqual(["OpenAlma token refresh failed (404)"])
    expect(h.sockets).toHaveLength(1)
    await h.controller.stop(true)
  })

  test("Stop during token mint opens no replacement socket", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness({tokenGate: gate})
    await start(h)
    h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
    h.sockets[0].message({goAway: {timeLeft: "50s"}})
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/token")))
    expect(h.sockets[0].readyState).toBe(1)
    const stopping = h.controller.stop(true)
    release()
    await stopping
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(h.sockets).toHaveLength(1)
    expect(h.errors).toEqual([])
  })

  test("GoAway deadline interrupts once and malformed duration fails loud", async () => {
    const deadline = harness()
    await start(deadline)
    deadline.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
    deadline.sockets[0].message({serverContent: {inputTranscription: {text: "partial"}}})
    deadline.sockets[0].message({goAway: {timeLeft: "0.1s"}})
    await waitFor(() => deadline.sockets.length === 2)
    deadline.sockets[1].open()
    deadline.sockets[1].message({setupComplete: {}})
    await waitFor(() => deadline.reconnecting.at(-1) === false)
    expect(deadline.events.filter((event) => event === "interrupted")).toHaveLength(1)
    expect(deadline.errors).toEqual([])
    await deadline.controller.stop()

    const malformed = harness()
    await start(malformed)
    malformed.sockets[0].message({goAway: {timeLeft: 50}})
    expect(malformed.errors).toEqual(["Gemini returned malformed GoAway"])
    await malformed.controller.stop()
  })

  test("socket close and GoAway report an interrupted image without an unhandled rejection", async () => {
    for (const cause of ["close", "goAway"] as const) {
      const h = harness({storage: new FakeStorage()})
      await start(h)
      h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
      await h.controller.sendImage({imageId: `image-${cause}`, mimeType: "image/png", data: "AQID"})
      h.sockets[0].message({serverContent: {outputTranscription: {text: "Partial caption."}}})

      if (cause === "close") h.sockets[0].close()
      else h.sockets[0].message({goAway: {timeLeft: "0.1s"}})
      await waitFor(() => h.errors.includes("Gemini image turn was interrupted"))

      expect(h.errors).toEqual(["Gemini image turn was interrupted"])
      await h.controller.stop()
    }
  })

  test("Stop during GoAway setup prevents a late replacement", async () => {
    const h = harness()
    await start(h)
    h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
    h.sockets[0].message({goAway: {timeLeft: "50s"}})
    await waitFor(() => h.sockets.length === 2)
    await h.controller.stop()
    h.sockets[1].open()
    h.sockets[1].message({setupComplete: {}})
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.sockets).toHaveLength(2)
    expect(h.errors).toEqual([])
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

  test("publishes latest valid usage at turn boundaries and ignores malformed metadata", async () => {
    const h = harness()
    await start(h)
    h.sockets[0].message({
      usageMetadata: {totalTokenCount: 123},
      serverContent: {
        inputTranscription: {text: "hello"},
        outputTranscription: {text: "hi"},
        turnComplete: true,
      },
    })
    h.sockets[0].message({
      usageMetadata: {totalTokenCount: "private-bad"},
      serverContent: {
        inputTranscription: {text: "again"},
        outputTranscription: {text: "still here"},
        turnComplete: true,
      },
    })
    expect(h.usage).toEqual([123, 123])
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("duration warning fires once without stopping the sitting", async () => {
    const h = harness({warningSeconds: 0.01})
    await start(h)
    await waitFor(() => h.durationWarnings === 1)
    expect(h.sockets[0].readyState).toBe(1)
    expect(h.requests.filter((request) => request.url.endsWith("/end"))).toHaveLength(0)
    await h.controller.stop()
  })

  test("temporary heartbeat failures do not tear down a healthy provider socket", async () => {
    for (const options of [{heartbeatStatus: 503}, {heartbeatThrows: true}]) {
      const h = harness({leaseSeconds: 0.03, ...options})
      await start(h)
      await waitFor(() => h.requests.some((request) => request.url.endsWith("/heartbeat")))
      expect(h.errors).toEqual([])
      expect(h.sockets[0].readyState).toBe(1)
      await h.controller.stop()
    }
  })

  test("persistent heartbeat failure becomes fatal when the known lease expires", async () => {
    const h = harness({leaseSeconds: 0.03, heartbeatStatus: 503})
    await start(h)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.errors).toEqual(["OpenAlma heartbeat lease expired"])
    await h.controller.stop()
  })
})
