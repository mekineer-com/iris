import {describe, expect, spyOn, test} from "bun:test"

import {GeminiLiveController, journalSoulId, JOURNAL_KEY, PHOTO_CAPTION_INSTRUCTION, RECOVERED_CHATS_KEY} from "./GeminiLiveController"
import type {OpenAlmaConfig} from "./openAlmaConfig"
import {PHOTO_RETRY_MESSAGE, type PhotoCaption} from "../shared/types"

const CONFIG: OpenAlmaConfig = {
  baseUrl: "http://127.0.0.1:9999",
  userId: "Test User",
  soulId: "Test Soul",
  deviceSessionId: "test-phone",
  packageName: "com.openalma.mentra",
  version: "0.1.0",
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

function photoInput(message: any): {data: string; mimeType: string} | undefined {
  return message.clientContent?.turns?.[0]?.parts?.find((part: any) => part.inlineData)?.inlineData
}

function photoTask(message: any): string | undefined {
  return photoInput(message) ? message.clientContent.turns[0].parts.find((part: any) => typeof part.text === "string")?.text : undefined
}

function textTurn(message: any): any {
  return photoInput(message) ? undefined : message.clientContent
}

function photoTurn(imageId: string, data = "AQID", mimeType = "image/png") {
  return {clientContent: {turns: [{role: "user", parts: [{inlineData: {data, mimeType}},
    {text: `image_id: ${imageId}\n${PHOTO_CAPTION_INSTRUCTION}`}]}], turnComplete: true}}
}

class FakeStorage {
  values = new Map<string, string>()
  setCalls = 0
  setGate: Promise<void> | null = null

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null
  }

  async keys(): Promise<string[]> {
    return [...this.values.keys()]
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
    config?: OpenAlmaConfig
    heartbeatMs?: number
    setupTimeoutMs?: number
    photoDrainTimeoutMs?: number
    heartbeatStatus?: number
    heartbeatThrows?: boolean
    heartbeatBody?: unknown
    heartbeatGate?: Promise<void>
    startGate?: Promise<void>
    startStatus?: number
    startSequence?: number
    startBody?: unknown
    startResults?: Array<{status: number; body: unknown}>
    tokenGate?: Promise<void>
    tokenStatuses?: number[]
    leaseSeconds?: number
    appendStatuses?: number[]
    appendGates?: Promise<void>[]
    appendAckLost?: boolean
    history?: Array<{event_id: string; role: string; event_kind: string; content: string; mic_source?: string; media_ref?: string; status?: string}>
    snapshotStatus?: number
    snapshotThrows?: boolean
    snapshotGate?: Promise<void>
    snapshotResponse?: Response
    replayGates?: Promise<void>[]
    replayResponses?: Response[]
    replayStatuses?: number[]
    replayBodies?: unknown[]
    finalizeStatuses?: number[]
    finalizeGates?: Promise<void>[]
    recallGate?: Promise<void>
    recallStatus?: number
    recallBody?: unknown
    workingGate?: Promise<void>
    workingStatus?: number
    workingBodies?: unknown[]
    workingThrows?: boolean
    stalledBodyPath?: string
    bodyTransportFailure?: boolean
    storage?: FakeStorage
    warningSeconds?: number
    onError?: () => void
  } = {},
) {
  const sockets: FakeSocket[] = []
  const socketUrls: string[] = []
  const requests: Array<{url: string; body: any; authorization: string | null}> = []
  const audio: string[] = []
  const events: string[] = []
  const errors: string[] = []
  const persistenceErrors: Array<string | null> = []
  const photoRetryChanges: boolean[] = []
  const photoCaptions: Array<PhotoCaption & {acknowledgmentOnly: boolean}> = []
  const finalizations: Array<{ok: boolean; durable: boolean; queued: boolean}> = []
  const reconnecting: boolean[] = []
  const usage: number[] = []
  let durationWarnings = 0
  const appendStatuses = [...(options.appendStatuses ?? [])]
  const appendGates = [...(options.appendGates ?? [])]
  const startResults = [...(options.startResults ?? [])]
  const tokenStatuses = [...(options.tokenStatuses ?? [])]
  const finalizeStatuses = [...(options.finalizeStatuses ?? [])]
  const finalizeGates = [...(options.finalizeGates ?? [])]
  const replayGates = [...(options.replayGates ?? [])]
  const replayResponses = [...(options.replayResponses ?? [])]
  const replayStatuses = [...(options.replayStatuses ?? [])]
  const replayBodies = [...(options.replayBodies ?? [])]
  const workingBodies = [...(options.workingBodies ?? [])]
  let refreshedTokens = 0
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body ?? "{}"))
    requests.push({url, body, authorization: new Headers(init?.headers).get("Authorization")})
    if (options.stalledBodyPath && url.endsWith(options.stalledBodyPath)) {
      return new Response(new ReadableStream({start(controller) {
        if (options.bodyTransportFailure) controller.error(new TypeError("Timed out"))
        else init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Timed out", "AbortError")), {once: true})
      }}), {headers: {"Content-Type": "application/json"}})
    }
    if (url.endsWith("/session/start")) {
      if (options.startGate) await options.startGate
      const result = startResults.shift()
      return Response.json(
        result?.body ?? options.startBody ?? {
          session_id: "sitting-1",
          next_transcript_sequence: options.startSequence ?? 41,
          ephemeral_token: "ephemeral/test",
          websocket: {
            api_version: "v1beta",
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
      if (options.heartbeatGate) await options.heartbeatGate
      if (options.heartbeatThrows) throw new Error("fictional network miss")
      return Response.json(options.heartbeatBody ?? {ok: true}, {status: options.heartbeatStatus ?? 200})
    }
    if (url.endsWith("/recall")) {
      if (options.recallGate) await options.recallGate
      return Response.json(
        options.recallBody ?? {ok: true, context: "A compact fictional memory.", retrieve_ms: 123},
        {status: options.recallStatus ?? 200},
      )
    }
    if (["/working-state", "/working-thought", "/annul-intention"].some((path) => url.endsWith(path))) {
      if (options.workingGate) await options.workingGate
      if (options.workingThrows) throw new Error("fictional lost write acknowledgement")
      return Response.json(workingBodies.shift() ?? {ok: true, status: "saved"}, {status: options.workingStatus ?? 200})
    }
    if (url.endsWith("/transcripts/append")) {
      await appendGates.shift()
      const sitting = decodeURIComponent(new URL(url).pathname.match(/\/session\/([^/]+)\/transcripts\/append$/)![1])
      if (body.events.some((event: any) => event.event_id !== `${sitting}:${event.sequence}`)) {
        return Response.json({detail: "Transcript event ID does not match sitting and sequence"}, {status: 409})
      }
      const status = appendStatuses.shift() ?? 200
      if (status === 200) {
        options.history?.push(...body.events)
        if (options.appendAckLost) throw new Error("fictional lost append acknowledgement")
      }
      return Response.json(
        {ok: true, ack_sequence: body.events.at(-1)?.sequence ?? 0},
        {status},
      )
    }
    if (url.endsWith("/snapshot/finalize")) {
      if (finalizeGates.length) await finalizeGates.shift()
      const status = finalizeStatuses.shift() ?? 200
      const result = {ok: status === 200, durable: status === 200, queued: status === 200}
      finalizations.push(result)
      return Response.json(result, {status})
    }
    if (url.endsWith("/snapshot/replay")) {
      await replayGates.shift()
      if (replayResponses.length) return replayResponses.shift()!
      return Response.json(
        replayBodies.shift() ?? {mime_type: "image/png", data: "AQID"},
        {status: replayStatuses.shift() ?? 200},
      )
    }
    if (url.endsWith("/snapshot")) {
      if (options.snapshotThrows) throw new Error("fictional upload acknowledgment lost")
      if (options.snapshotGate) await options.snapshotGate
      if (options.snapshotResponse) return options.snapshotResponse
      const extension = body.mime_type === "image/jpeg" ? "jpg" : "png"
      return Response.json(
        {ok: true, media_ref: `mentra_media/test-phone/${body.image_id}.${extension}`},
        {status: options.snapshotStatus ?? 200},
      )
    }
    return Response.json({ok: true})
  }
  const controller = new GeminiLiveController(
    options.config ?? CONFIG,
    {
      onAudio: (data) => audio.push(data),
      onTurnComplete: (finalResponse) => events.push(finalResponse ? "turnComplete" : "toolBoundary"),
      onInterrupted: () => events.push("interrupted"),
      onReconnecting: (value) => reconnecting.push(value),
      onUsage: (totalTokens) => usage.push(totalTokens),
      onDurationWarning: () => {
        durationWarnings += 1
      },
      onPhotoRetryChange: (pending) => photoRetryChanges.push(pending),
      onPhotoCaption: (caption, acknowledgmentOnly) => photoCaptions.push({...caption, acknowledgmentOnly}),
      onPersistenceError: (message) => persistenceErrors.push(message),
      onError: (error) => { errors.push(error.message); options.onError?.() },
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
      photoDrainTimeoutMs: options.photoDrainTimeoutMs ?? 25,
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
    photoRetryChanges,
    photoCaptions,
    finalizations,
    finalizeStatuses,
    finalizeGates,
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

function saveCaption(socket: FakeSocket, imageId: string, caption: string, id = `caption-${imageId}`): void {
  socket.message({toolCall: {functionCalls: [{id, name: "save_photo_caption", args: {image_id: imageId, caption}}]}})
}

async function start(h: ReturnType<typeof harness>, mode: "continuous" | "manual" = "continuous"): Promise<void> {
  const starting = h.controller.start(mode)
  await waitFor(() => h.sockets.length === 1)
  h.sockets[0].open()
  expect(JSON.parse(h.sockets[0].sent[0])).toEqual({setup: {sessionResumption: {}}})
  h.sockets[0].message(new TextEncoder().encode(JSON.stringify({setupComplete: {}})).buffer)
  await starting
}

function completeTurn(h: ReturnType<typeof harness>, input = "hello", output = "hi", activityStarted = false): void {
  if (input.trim()) {
    if (!activityStarted) h.sockets.at(-1)!.message({voiceActivity: {type: "ACTIVITY_START"}})
    h.sockets.at(-1)!.message({voiceActivity: {type: "ACTIVITY_END"}})
  }
  h.sockets.at(-1)!.message({
    serverContent: {
      inputTranscription: {text: input},
      outputTranscription: {text: output},
      ...(output.trim() ? {modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}} : {}),
      turnComplete: true,
    },
  })
}

function functionResponses(socket: FakeSocket): Array<{id: string; name: string; scheduling: string; response: any}> {
  return socket.sent.flatMap(value => JSON.parse(value).toolResponse?.functionResponses ?? [])
}

function admitRequest(h: ReturnType<typeof harness>, mode: "continuous" | "manual"): void {
  if (mode === "manual") h.controller.sendActivity(["AAAA"], "phone")
  else {
    h.controller.sendAudio("AAAA", "phone")
    h.sockets.at(-1)!.message({voiceActivity: {type: "ACTIVITY_START"}})
    h.sockets.at(-1)!.message({voiceActivity: {type: "ACTIVITY_END"}})
  }
}

describe("GeminiLiveController", () => {
  test.each(["continuous", "manual"] as const)("%s holds a ready recall result until native request completion", async mode => {
    const h = harness()
    await start(h, mode)
    try {
      admitRequest(h, mode)
      h.sockets[0].message({serverContent: {inputTranscription: {text: "Where was the fictional beacon?"}}})
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "owed-recall", name: "recall_memory", args: {query: "fictional beacon"}},
      ]}})
      await waitFor(() => h.requests.some(request => request.url.endsWith("/recall")))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(functionResponses(h.sockets[0])).toEqual([])
      h.sockets[0].message({serverContent: {generationComplete: true}})
      expect(functionResponses(h.sockets[0])).toEqual([])
      h.sockets[0].message({serverContent: {turnComplete: true}})
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "owed-recall"))
      expect(functionResponses(h.sockets[0])).toContainEqual({
        id: "owed-recall", name: "recall_memory", scheduling: "WHEN_IDLE",
        response: {result: "A compact fictional memory."},
      })
      h.sockets[0].message({serverContent: {outputTranscription: {text: "Beside the fictional harbor."},
        modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}, turnComplete: true}})
      expect(h.events.at(-1)).toBe("turnComplete")
      expect(h.errors).toEqual([])
    } finally {
      await h.controller.stop()
    }
  })

  test.each(["co-packet", "split"] as const)("%s tools and completion retain the admitted answer obligation", async packet => {
    const h = harness()
    await start(h)
    try {
      admitRequest(h, "continuous")
      const toolCall = {functionCalls: [{id: "native-batch", name: "recall_memory", args: {query: "fictional harbor"}}]}
      h.sockets[0].message({toolCall, ...(packet === "co-packet" ? {serverContent: {turnComplete: true}} : {})})
      if (packet === "split") h.sockets[0].message({serverContent: {turnComplete: true}})
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "native-batch"))
      expect(functionResponses(h.sockets[0]).find(response => response.id === "native-batch")?.scheduling).toBe("WHEN_IDLE")
      expect(h.errors).toEqual([])
    } finally {
      await h.controller.stop()
    }
  })

  test("background-only recall stays SILENT without inventing a spoken request", async () => {
    const h = harness()
    await start(h)
    try {
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "background-recall", name: "recall_memory", args: {query: "fictional background"}},
      ]}})
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "background-recall"))
      h.sockets[0].message({serverContent: {turnComplete: true}})
      expect(functionResponses(h.sockets[0]).every(response => response.scheduling === "SILENT")).toBe(true)
      expect(h.audio).toEqual([])
      expect(h.errors).toEqual([])
    } finally {
      await h.controller.stop()
    }
  })

  test.each(["before-result", "after-result"] as const)("audible answer %s makes the tool result SILENT", async ordering => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const h = harness({recallGate: gate})
    await start(h)
    try {
      admitRequest(h, "continuous")
      h.sockets[0].message({serverContent: {inputTranscription: {text: "Recall the fictional harbor."}},
        toolCall: {functionCalls: [{id: "answered-recall", name: "recall_memory", args: {query: "harbor"}}]}})
      await waitFor(() => h.requests.some(request => request.url.endsWith("/recall")))
      if (ordering === "after-result") {
        release()
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(functionResponses(h.sockets[0])).toEqual([])
      }
      h.sockets[0].message({serverContent: {outputTranscription: {text: "I remember the harbor."},
        modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}, turnComplete: true}})
      release()
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "answered-recall"))
      expect(functionResponses(h.sockets[0]).find(response => response.id === "answered-recall")?.scheduling).toBe("SILENT")
      expect(h.audio).toEqual(["AAAAAA=="])
      expect(h.errors).toEqual([])
    } finally {
      release()
      await h.controller.stop()
    }
  })

  test.each([
    {mode: "continuous", fast: "recall"}, {mode: "continuous", fast: "working"},
    {mode: "manual", fast: "recall"}, {mode: "manual", fast: "working"},
  ] as const)("$mode batch with fast $fast holds the cohort then wakes once", async ({mode, fast}) => {
    let releaseRecall!: () => void
    let releaseWorking!: () => void
    const h = harness({
      recallGate: new Promise<void>(resolve => { releaseRecall = resolve }),
      workingGate: new Promise<void>(resolve => { releaseWorking = resolve }),
    })
    await start(h, mode)
    try {
      admitRequest(h, mode)
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "batch-recall", name: "recall_memory", args: {query: "fictional lighthouse"}},
        {id: "batch-working", name: "read_working_state", args: {}},
      ]}})
      await waitFor(() => ["/recall", "/working-state"].every(path => h.requests.some(request => request.url.endsWith(path))))
      ;(fast === "recall" ? releaseRecall : releaseWorking)()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(functionResponses(h.sockets[0])).toEqual([])
      h.sockets[0].message({serverContent: {turnComplete: true}})
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(functionResponses(h.sockets[0])).toEqual([])
      h.sockets[0].message({serverContent: {turnComplete: true}})
      ;(fast === "recall" ? releaseWorking : releaseRecall)()
      await waitFor(() => functionResponses(h.sockets[0]).length === 2)
      expect(functionResponses(h.sockets[0]).map(response => [response.id, response.scheduling]))
        .toEqual([["batch-recall", "SILENT"], ["batch-working", "WHEN_IDLE"]])
      expect(functionResponses(h.sockets[0]).filter(response => response.scheduling === "WHEN_IDLE")).toHaveLength(1)
      expect(h.errors).toEqual([])
    } finally {
      releaseRecall()
      releaseWorking()
      await h.controller.stop()
    }
  })

  test("a fresh second tool round may continue the same unanswered request", async () => {
    const h = harness()
    await start(h)
    try {
      admitRequest(h, "continuous")
      for (const id of ["first-round", "second-round"]) {
        h.sockets[0].message({toolCall: {functionCalls: [
          {id, name: "recall_memory", args: {query: `fictional ${id}`}},
        ]}, serverContent: {turnComplete: true}})
        await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === id))
        expect(functionResponses(h.sockets[0]).find(response => response.id === id)?.scheduling).toBe("WHEN_IDLE")
      }
      expect(h.errors).toEqual([])
    } finally {
      await h.controller.stop()
    }
  })

  test("a foreground cohort waits for every result and native completion across pending batches", async () => {
    let releaseRecall!: () => void
    let releaseWorking!: () => void
    const h = harness({
      recallGate: new Promise<void>(resolve => { releaseRecall = resolve }),
      workingGate: new Promise<void>(resolve => { releaseWorking = resolve }),
    })
    await start(h)
    try {
      admitRequest(h, "continuous")
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "extant-first", name: "recall_memory", args: {query: "fictional harbor"}},
      ]}, serverContent: {turnComplete: true}})
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "extant-second", name: "read_working_state", args: {}},
      ]}})
      releaseRecall()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(functionResponses(h.sockets[0])).toEqual([])
      releaseWorking()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(functionResponses(h.sockets[0])).toEqual([])
      h.sockets[0].message({serverContent: {turnComplete: true}})
      await waitFor(() => functionResponses(h.sockets[0]).length === 2)
      expect(functionResponses(h.sockets[0]).map(response => [response.id, response.scheduling]))
        .toEqual([["extant-first", "SILENT"], ["extant-second", "WHEN_IDLE"]])
      expect(functionResponses(h.sockets[0]).filter(response => response.scheduling === "WHEN_IDLE")).toHaveLength(1)
      expect(h.errors).toEqual([])
    } finally {
      releaseRecall()
      releaseWorking()
      await h.controller.stop()
    }
  })

  test("late ASR cannot revive a terminal silent request for a background recall", async () => {
    const h = harness()
    await start(h)
    try {
      admitRequest(h, "continuous")
      h.sockets[0].message({serverContent: {turnComplete: true}})
      expect(h.events.at(-1)).toBe("turnComplete")
      h.sockets[0].message({serverContent: {inputTranscription: {text: "Late fictional words."}}})
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "late-background", name: "recall_memory", args: {query: "fictional background"}},
      ]}, serverContent: {turnComplete: true}})
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "late-background"))
      expect(functionResponses(h.sockets[0]).find(response => response.id === "late-background")?.scheduling).toBe("SILENT")
      expect(h.errors).toEqual([])
    } finally {
      await h.controller.stop()
    }
  })

  test("an old request's late result cannot wake a newer unanswered request", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const h = harness({recallGate: gate})
    await start(h)
    try {
      admitRequest(h, "continuous")
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "old-request", name: "recall_memory", args: {query: "old fictional request"}},
      ]}, serverContent: {turnComplete: true}})
      admitRequest(h, "continuous")
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "new-request", name: "read_working_state", args: {}},
      ]}, serverContent: {turnComplete: true}})
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "new-request"))
      expect(functionResponses(h.sockets[0]).find(response => response.id === "new-request")?.scheduling).toBe("WHEN_IDLE")
      release()
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "old-request"))
      expect(functionResponses(h.sockets[0]).find(response => response.id === "old-request")?.scheduling).toBe("SILENT")
      expect(h.errors).toEqual([])
    } finally {
      release()
      await h.controller.stop()
    }
  })

  test("cancelling the last pending tool settles Manual without a late wake", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const h = harness({recallGate: gate})
    await start(h, "manual")
    try {
      admitRequest(h, "manual")
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "manual-cancel", name: "recall_memory", args: {query: "fictional cancellation"}},
      ]}, serverContent: {turnComplete: true}})
      expect(h.events.at(-1)).toBe("toolBoundary")
      h.sockets[0].message({toolCallCancellation: {ids: ["manual-cancel"]}})
      expect(h.events.at(-1)).toBe("turnComplete")
      release()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(functionResponses(h.sockets[0])).toEqual([])
      expect(h.errors).toEqual([])
    } finally {
      release()
      await h.controller.stop()
    }
  })

  test.each(["recall", "working"] as const)("cancelling the %s sibling leaves the surviving result able to wake", async cancelled => {
    let releaseRecall!: () => void
    let releaseWorking!: () => void
    const h = harness({
      recallGate: new Promise<void>(resolve => { releaseRecall = resolve }),
      workingGate: new Promise<void>(resolve => { releaseWorking = resolve }),
    })
    await start(h, "manual")
    try {
      admitRequest(h, "manual")
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "cancel-recall", name: "recall_memory", args: {query: "fictional beacon"}},
        {id: "cancel-working", name: "read_working_state", args: {}},
      ]}, serverContent: {turnComplete: true}})
      await waitFor(() => ["/recall", "/working-state"].every(path => h.requests.some(request => request.url.endsWith(path))))
      h.sockets[0].message({toolCallCancellation: {ids: [`cancel-${cancelled}`]}})
      expect(h.events.at(-1)).toBe("toolBoundary")
      releaseRecall()
      releaseWorking()
      await waitFor(() => functionResponses(h.sockets[0]).length === 1)
      expect(functionResponses(h.sockets[0])[0]).toMatchObject({
        id: `cancel-${cancelled === "recall" ? "working" : "recall"}`, scheduling: "WHEN_IDLE",
      })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(functionResponses(h.sockets[0])).toHaveLength(1)
      expect(h.errors).toEqual([])
    } finally {
      releaseRecall()
      releaseWorking()
      await h.controller.stop()
    }
  })

  test("cancelling slow recall after working state is ready still wakes the owed answer with that result", async () => {
    let releaseRecall!: () => void
    const h = harness({recallGate: new Promise<void>(resolve => { releaseRecall = resolve })})
    await start(h, "manual")
    try {
      admitRequest(h, "manual")
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "ready-working", name: "read_working_state", args: {}},
        {id: "cancel-after-ready", name: "recall_memory", args: {query: "fictional beacon"}},
      ]}, serverContent: {inputTranscription: {text: "Use the fictional working state and memory."}, turnComplete: true}})
      await waitFor(() => ["/recall", "/working-state"].every(path => h.requests.some(request => request.url.endsWith(path))))
      // Drain the immediate working-state response while recall remains gated.
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(functionResponses(h.sockets[0])).toEqual([])
      h.sockets[0].message({toolCallCancellation: {ids: ["cancel-after-ready"]}})
      await waitFor(() => functionResponses(h.sockets[0]).length === 1)
      expect(functionResponses(h.sockets[0])[0]).toMatchObject({
        id: "ready-working", name: "read_working_state", response: {ok: true, status: "saved"}, scheduling: "WHEN_IDLE",
      })
      expect(h.events.at(-1)).toBe("toolBoundary")
      releaseRecall()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(functionResponses(h.sockets[0])).toHaveLength(1)
      completeTurn(h, "", "An answer using the fictional working state.")
      expect(h.events.at(-1)).toBe("turnComplete")
      expect(h.errors).toEqual([])
    } finally {
      releaseRecall()
      await h.controller.stop()
    }
  })

  test("split old interruption and completion cannot retire the newer admitted request", async () => {
    let release!: () => void
    const h = harness({recallGate: new Promise<void>(resolve => { release = resolve })})
    await start(h)
    try {
      admitRequest(h, "continuous")
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "interrupted-old", name: "recall_memory", args: {query: "old fictional harbor"}},
      ]}})
      h.sockets[0].message({voiceActivity: {type: "ACTIVITY_START"}})
      h.sockets[0].message({serverContent: {interrupted: true}})
      h.sockets[0].message({serverContent: {turnComplete: true}})
      release()
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "interrupted-old"))
      expect(functionResponses(h.sockets[0]).find(response => response.id === "interrupted-old")?.scheduling).toBe("SILENT")
      h.sockets[0].message({voiceActivity: {type: "ACTIVITY_END"}})
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "interrupting-new", name: "read_working_state", args: {}},
      ]}, serverContent: {turnComplete: true}})
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "interrupting-new"))
      expect(functionResponses(h.sockets[0]).find(response => response.id === "interrupting-new")?.scheduling).toBe("WHEN_IDLE")
      expect(h.errors).toEqual([])
    } finally {
      release()
      await h.controller.stop()
    }
  })

  test("an empty foreground A interrupted after B START cannot end B", async () => {
    const h = harness()
    await start(h)
    try {
      admitRequest(h, "continuous")
      h.sockets[0].message({voiceActivity: {type: "ACTIVITY_START"}})
      h.sockets[0].message({serverContent: {interrupted: true, turnComplete: true}})
      expect(h.events.at(-1)).toBe("toolBoundary")
      h.sockets[0].message({voiceActivity: {type: "ACTIVITY_END"}})
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "empty-a-new-b", name: "recall_memory", args: {query: "fictional B question"}},
      ]}})
      await waitFor(() => h.requests.some(request => request.url.endsWith("/recall")))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(functionResponses(h.sockets[0])).toEqual([])
      h.sockets[0].message({serverContent: {turnComplete: true}})
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "empty-a-new-b"))
      expect(functionResponses(h.sockets[0]).find(response => response.id === "empty-a-new-b")?.scheduling).toBe("WHEN_IDLE")
      expect(h.errors).toEqual([])
    } finally {
      await h.controller.stop()
    }
  })

  test("B's first tool payload takes ownership from empty retired non-continuing A", async () => {
    const h = harness()
    await start(h)
    try {
      admitRequest(h, "continuous")
      h.sockets[0].message({voiceActivity: {type: "ACTIVITY_START"}})
      h.sockets[0].message({voiceActivity: {type: "ACTIVITY_END"}})
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "empty-retired-a-new-b", name: "recall_memory", args: {query: "fictional B question"}},
      ]}})
      await waitFor(() => h.requests.some(request => request.url.endsWith("/recall")))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(functionResponses(h.sockets[0])).toEqual([])
      h.sockets[0].message({serverContent: {turnComplete: true}})
      await waitFor(() => functionResponses(h.sockets[0]).length === 1)
      expect(functionResponses(h.sockets[0])[0]).toMatchObject({id: "empty-retired-a-new-b", scheduling: "WHEN_IDLE"})
      expect(h.errors).toEqual([])
    } finally {
      await h.controller.stop()
    }
  })

  test.each([false, true])("fresh Continuous B during A's pending continuation owns its tools and output (audible=%s)", async audible => {
    const h = harness()
    await start(h)
    try {
      admitRequest(h, "continuous")
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "continuing-a", name: "recall_memory", args: {query: "fictional A"}},
      ]}, serverContent: {inputTranscription: {text: "Question A."}, turnComplete: true}})
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "continuing-a"))
      expect(functionResponses(h.sockets[0])[0].scheduling).toBe("WHEN_IDLE")
      admitRequest(h, "continuous")
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "new-b", name: "read_working_state", args: {}},
      ]}, serverContent: {inputTranscription: {text: "Question B."},
        ...(audible ? {outputTranscription: {text: "Answer B."}, modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}} : {}),
      }})
      await waitFor(() => h.requests.some(request => request.url.endsWith("/working-state")))
      await new Promise(resolve => setTimeout(resolve, 0))
      if (!audible) expect(functionResponses(h.sockets[0]).some(response => response.id === "new-b")).toBe(false)
      h.sockets[0].message({serverContent: {turnComplete: true}})
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "new-b"))
      expect(functionResponses(h.sockets[0]).find(response => response.id === "new-b")?.scheduling)
        .toBe(audible ? "SILENT" : "WHEN_IDLE")
      expect(h.events.at(-1)).toBe(audible ? "turnComplete" : "toolBoundary")
      expect(h.audio).toEqual(audible ? ["AAAAAA=="] : [])
      if (!audible) completeTurn(h, "", "Answer B.")
      expect(h.events.at(-1)).toBe("turnComplete")
      expect(h.errors).toEqual([])
    } finally {
      await h.controller.stop()
    }
  })

  test.each(["continuous", "manual"] as const)("%s incomplete continuation retires without output and resumes tools SILENT without re-execution", async mode => {
    const h = harness()
    await start(h, mode)
    try {
      h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "fictional-continuation-handle"}})
      admitRequest(h, mode)
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "completed-initial", name: "recall_memory", args: {query: "fictional first round"}},
      ]}, serverContent: {turnComplete: true}})
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "completed-initial"))
      expect(functionResponses(h.sockets[0]).find(response => response.id === "completed-initial")?.scheduling).toBe("WHEN_IDLE")
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "incomplete-continuation", name: "read_working_state", args: {}},
      ]}})
      await waitFor(() => h.requests.some(request => request.url.endsWith("/working-state")))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(functionResponses(h.sockets[0]).some(response => response.id === "incomplete-continuation")).toBe(false)
      expect(h.audio).toEqual([])
      expect(h.events.at(-1)).toBe("toolBoundary")
      h.sockets[0].close()
      await waitFor(() => h.sockets.length === 2)
      h.sockets[1].open()
      h.sockets[1].message({setupComplete: {}})
      await waitFor(() => functionResponses(h.sockets[1]).some(response => response.id === "incomplete-continuation"))
      expect(functionResponses(h.sockets[1]).find(response => response.id === "incomplete-continuation")?.scheduling).toBe("SILENT")
      expect(functionResponses(h.sockets[1]).some(response => response.id === "completed-initial")).toBe(false)
      expect(h.requests.filter(request => request.url.endsWith("/working-state"))).toHaveLength(1)
      expect(h.requests.filter(request => request.url.endsWith("/recall"))).toHaveLength(1)
      expect(h.events).not.toContain("interrupted")
      if (mode === "manual") {
        expect(h.events.at(-1)).toBe("turnComplete")
        expect(h.events.filter(event => event === "turnComplete")).toHaveLength(1)
      }
      expect(h.errors).toEqual([])
    } finally {
      await h.controller.stop()
    }
  })

  test("a completed background batch never adopts a later spoken request", async () => {
    let release!: () => void
    const h = harness({recallGate: new Promise<void>(resolve => { release = resolve })})
    await start(h)
    try {
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "completed-background", name: "recall_memory", args: {query: "fictional background"}},
      ]}, serverContent: {turnComplete: true}})
      admitRequest(h, "continuous")
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "later-admission", name: "read_working_state", args: {}},
      ]}, serverContent: {turnComplete: true}})
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "later-admission"))
      expect(functionResponses(h.sockets[0]).find(response => response.id === "later-admission")?.scheduling).toBe("WHEN_IDLE")
      release()
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "completed-background"))
      expect(functionResponses(h.sockets[0]).find(response => response.id === "completed-background")?.scheduling).toBe("SILENT")
      expect(h.errors).toEqual([])
    } finally {
      release()
      await h.controller.stop()
    }
  })

  test("background completion during active capture waits for the later spoken native boundary", async () => {
    let release!: () => void
    const h = harness({recallGate: new Promise<void>(resolve => { release = resolve })})
    await start(h)
    try {
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "overlapping-background", name: "recall_memory", args: {query: "fictional background"}},
      ]}})
      h.controller.sendAudio("AAAA", "phone")
      h.sockets[0].message({voiceActivity: {type: "ACTIVITY_START"}})
      h.sockets[0].message({serverContent: {turnComplete: true}})
      release()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(functionResponses(h.sockets[0])).toEqual([])
      h.sockets[0].message({voiceActivity: {type: "ACTIVITY_END"}})
      expect(functionResponses(h.sockets[0])).toEqual([])
      h.sockets[0].message({serverContent: {inputTranscription: {text: "A fictional overlapping question."}, turnComplete: true}})
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "overlapping-background"))
      expect(functionResponses(h.sockets[0]).find(response => response.id === "overlapping-background")?.scheduling).toBe("WHEN_IDLE")
      expect(h.errors).toEqual([])
    } finally {
      release()
      await h.controller.stop()
    }
  })

  test("Stop flushes an already-ready held result SILENT without native completion", async () => {
    const h = harness()
    await start(h, "manual")
    try {
      admitRequest(h, "manual")
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "held-at-stop", name: "recall_memory", args: {query: "fictional stopped question"}},
      ]}})
      await waitFor(() => h.requests.some(request => request.url.endsWith("/recall")))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(functionResponses(h.sockets[0])).toEqual([])
      await h.controller.stop()
      expect(functionResponses(h.sockets[0])).toContainEqual({
        id: "held-at-stop", name: "recall_memory", scheduling: "SILENT",
        response: {result: "A compact fictional memory."},
      })
      expect(h.audio).toEqual([])
      expect(h.errors).toEqual([])
    } finally {
      await h.controller.stop()
    }
  })

  test("Stop never wakes a completed request whose recall is still pending", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const h = harness({recallGate: gate})
    await start(h)
    try {
      admitRequest(h, "continuous")
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "stopped-request", name: "recall_memory", args: {query: "fictional stopped request"}},
      ]}, serverContent: {turnComplete: true}})
      await h.controller.stop()
      release()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(functionResponses(h.sockets[0])).toEqual([])
      expect(h.audio).toEqual([])
      expect(h.errors).toEqual([])
    } finally {
      release()
      await h.controller.stop()
    }
  })

  test.each(["close", "goAway"] as const)("completed pending answer obligation survives %s resumption", async cause => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const h = harness({recallGate: gate})
    await start(h)
    try {
      h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "fictional-answer-handle"}})
      admitRequest(h, "continuous")
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "resumed-answer", name: "recall_memory", args: {query: "fictional resumption"}},
      ]}, serverContent: {turnComplete: true}})
      if (cause === "close") h.sockets[0].close()
      else h.sockets[0].message({goAway: {timeLeft: "0.1s"}})
      await waitFor(() => h.sockets.length === 2)
      h.sockets[1].open()
      expect(JSON.parse(h.sockets[1].sent[0])).toEqual({setup: {sessionResumption: {handle: "fictional-answer-handle"}}})
      h.sockets[1].message({setupComplete: {}})
      expect(h.events.at(-1)).toBe("toolBoundary")
      release()
      await waitFor(() => functionResponses(h.sockets[1]).some(response => response.id === "resumed-answer"))
      expect(functionResponses(h.sockets[0])).toEqual([])
      expect(functionResponses(h.sockets[1]).find(response => response.id === "resumed-answer")?.scheduling).toBe("WHEN_IDLE")
      expect(h.errors).toEqual([])
    } finally {
      release()
      await h.controller.stop()
    }
  })

  test("resumption cannot manufacture native completion for an unfinished request", async () => {
    let release!: () => void
    const h = harness({recallGate: new Promise<void>(resolve => { release = resolve })})
    await start(h)
    try {
      h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "fictional-unfinished-handle"}})
      admitRequest(h, "continuous")
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "unfinished-reconnect", name: "recall_memory", args: {query: "unfinished fictional request"}},
      ]}})
      h.sockets[0].close()
      await waitFor(() => h.sockets.length === 2)
      h.sockets[1].open()
      h.sockets[1].message({setupComplete: {}})
      release()
      await waitFor(() => functionResponses(h.sockets[1]).some(response => response.id === "unfinished-reconnect"))
      expect(functionResponses(h.sockets[1]).find(response => response.id === "unfinished-reconnect")?.scheduling).toBe("SILENT")
      expect(h.errors).toEqual([])
    } finally {
      release()
      await h.controller.stop()
    }
  })

  test.each(["continuous", "manual"] as const)("%s photo overlap hands off the stored original independently before continuing the answer", async mode => {
    let releaseAppend!: () => void
    const appendGate = new Promise<void>(resolve => { releaseAppend = resolve })
    const storage = new FakeStorage()
    const h = harness({storage, appendGates: [appendGate]})
    await start(h, mode)
    try {
      await h.controller.sendImage({imageId: "overlap-original", mimeType: "image/png", data: "AQID"})
      expect(h.requests.find(request => request.url.endsWith("/snapshot"))?.body.image_id).toBe("overlap-original")
      expect(JSON.parse(storage.values.get(JOURNAL_KEY)!).pendingImage.mediaRef).toBe("mentra_media/test-phone/overlap-original.png")
      admitRequest(h, mode)
      saveCaption(h.sockets[0], "overlap-original", "A fictional green triangle.", "overlap-caption")
      await waitFor(() => h.finalizations.some(result => result.durable))
      const receipt = h.requests.find(request => request.url.endsWith("/snapshot/finalize"))!
      expect(receipt.body).toMatchObject({image_id: "overlap-original", caption: "A fictional green triangle.",
        caption_event_id: "sitting-1:photo:overlap-original"})
      expect(functionResponses(h.sockets[0])).toEqual([])
      expect(h.audio).toEqual([])
      h.sockets[0].message({serverContent: {turnComplete: true}})
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "overlap-caption"))
      expect(functionResponses(h.sockets[0]).find(response => response.id === "overlap-caption")).toMatchObject({
        scheduling: "WHEN_IDLE", response: {ok: true, durable: true},
      })
      h.sockets[0].message({serverContent: {inputTranscription: {text: "Where is the fictional harbor?"},
        outputTranscription: {text: "The harbor is north."}, modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}, turnComplete: true}})
      releaseAppend()
      await h.controller.stop()
      const rows = h.requests.flatMap(request => request.body.events ?? [])
      expect(rows.find(row => row.event_kind === "photo_caption")).toMatchObject({
        content: "A fictional green triangle.", media_ref: "mentra_media/test-phone/overlap-original.png",
      })
      expect(rows.some(row => row.event_kind === "transcript" && row.role === "assistant" && row.content === "The harbor is north.")).toBe(true)
      expect(rows.some(row => row.event_kind === "transcript" && row.content === "A fictional green triangle.")).toBe(false)
      expect(h.errors).toEqual([])
    } finally {
      releaseAppend()
      await h.controller.stop()
    }
  })

  test("initial ASR co-packet speech precedes the internal caption and its answered ACK is SILENT", async () => {
    const storage = new FakeStorage()
    const h = harness({storage})
    await start(h)
    try {
      await h.controller.sendImage({imageId: "asr-copacket-original", mimeType: "image/png", data: "AQID"})
      expect(JSON.parse(storage.values.get(JOURNAL_KEY)!).pendingImage.mediaRef)
        .toBe("mentra_media/test-phone/asr-copacket-original.png")
      // No START or Manual Send: these are the sitting's first spoken words.
      h.sockets[0].message({
        toolCall: {functionCalls: [{id: "asr-copacket-caption", name: "save_photo_caption",
          args: {image_id: "asr-copacket-original", caption: "A fictional amber circle."}}]},
        serverContent: {
          inputTranscription: {text: "Where is the fictional harbor?"},
          outputTranscription: {text: "The harbor is north."},
          modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]},
          turnComplete: true,
        },
      })
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "asr-copacket-caption"))
      expect(h.finalizations).toContainEqual({ok: true, durable: true, queued: true})
      expect(h.requests.find(request => request.url.endsWith("/snapshot/finalize"))?.body).toMatchObject({
        image_id: "asr-copacket-original", caption: "A fictional amber circle.",
        caption_event_id: "sitting-1:photo:asr-copacket-original",
      })
      expect(functionResponses(h.sockets[0]).find(response => response.id === "asr-copacket-caption"))
        .toMatchObject({scheduling: "SILENT", response: {ok: true, durable: true}})
      expect(h.audio).toEqual(["AAAAAA=="])
      await h.controller.stop()
      const rows = h.requests.flatMap(request => request.body.events ?? [])
      expect(rows.filter(row => row.event_kind === "transcript" || row.event_kind === "photo_caption")
        .map(row => [row.event_kind, row.role, row.content])).toEqual([
        ["transcript", "user", "Where is the fictional harbor?"],
        ["transcript", "assistant", "The harbor is north."],
        ["photo_caption", "assistant", "A fictional amber circle."],
      ])
      expect(h.errors).toEqual([])
    } finally {
      await h.controller.stop()
    }
  })

  test.each([["continuous", false], ["manual", false], ["continuous", true]] as const)(
    "%s publishes normal speech without waiting for Stop (input before START=%s)", async (mode, inputBeforeStart) => {
    const h = harness({storage: new FakeStorage()})
    await start(h, mode)
    if (mode === "manual") h.controller.sendActivity(["AAAA"], "phone")
    else h.controller.sendAudio("AAAA", "phone")
    if (inputBeforeStart) h.sockets[0].message({serverContent: {inputTranscription: {text: "A fictional "}}})
    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_START"}})
    if (!inputBeforeStart) h.sockets[0].message({serverContent: {inputTranscription: {text: "A fictional "}}})
    h.sockets[0].message({serverContent: {inputTranscription: {text: "normal question."}}})
    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_END"}})
    h.sockets[0].message({serverContent: {outputTranscription: {text: "A normal answer."},
      modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}, turnComplete: true}})
    await waitFor(() => h.requests.some(request => request.url.endsWith("/transcripts/append")))
    const rows = h.requests.flatMap(request => request.body.events ?? [])
    expect(rows.map(row => [row.role, row.content, row.status])).toEqual([
      ["user", "A fictional normal question.", "complete"], ["assistant", "A normal answer.", "complete"],
    ])
    expect(rows[0].mic_source).toBe("phone")
    expect(h.requests.some(request => request.url.endsWith("/end"))).toBe(false)
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("Continuous reply completion cannot finalize words while native capture is still active", async () => {
    const storage = new FakeStorage()
    const h = harness({storage})
    await start(h)
    h.controller.sendAudio("AAAA", "phone")
    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_START"}})
    h.sockets[0].message({serverContent: {inputTranscription: {text: "Keep these first "}}})
    h.sockets[0].message({serverContent: {outputTranscription: {text: "A reply before capture ended."},
      modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}, turnComplete: true}})
    await waitFor(() => {
      const drafts = JSON.parse(storage.values.get(JOURNAL_KEY) || "{}").draftTranscripts
      return drafts?.length === 2 && drafts[0].speech?.waiting === true
    })
    expect(h.requests.some(request => request.url.endsWith("/transcripts/append"))).toBe(false)
    expect(h.errors).toEqual([])
    h.sockets[0].message({serverContent: {inputTranscription: {text: "and remaining words."}}})
    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_END"}})
    await h.controller.stop()
    const rows = h.requests.flatMap(request => request.body.events ?? [])
    expect(rows.map(row => [row.event_kind, row.role, row.content, row.status])).toEqual([
      ["transcript", "user", "Keep these first and remaining words.", "complete"],
      ["transcript", "assistant", "A reply before capture ended.", "complete"],
    ])
    expect(rows[0].mic_source).toBe("phone")
    expect(h.persistenceErrors).not.toContain("Some spoken words could not be transcribed")
    expect(h.errors).toEqual([])
  })

  test.each(["continuous", "manual"] as const)("%s keeps uncertain overlap local, uploads clean C before Stop, and exposes missing D", async mode => {
    const h = harness({storage: new FakeStorage()})
    await start(h, mode)
    try {
      admitRequest(h, mode)
      completeTurn(h, "Previously submitted words.", "Previously submitted answer.", true)
      await waitFor(() => h.requests.some(request => request.url.endsWith("/transcripts/append")))
      const first = h.requests.find(request => request.url.endsWith("/transcripts/append"))!
      const submitted = JSON.stringify(first.body)
      const originals = new Map(first.body.events.map((row: any) => [row.event_id, JSON.stringify(row)]))
      const appendCount = h.requests.filter(request => request.url.endsWith("/transcripts/append")).length

      admitRequest(h, mode)
      completeTurn(h, "", "Answer A before its transcription.")
      admitRequest(h, mode)
      h.sockets[0].message({serverContent: {inputTranscription: {text: "Delayed A words. "}}})
      h.sockets[0].message({serverContent: {inputTranscription: {text: "B words."}}})
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(h.requests.filter(request => request.url.endsWith("/transcripts/append"))).toHaveLength(appendCount)
      completeTurn(h, "", "Answer B at the clean native boundary.")

      admitRequest(h, mode)
      completeTurn(h, "Clean C words.", "Clean C answer.", true)
      await waitFor(() => h.requests.some(request => request.body.events?.some((row: any) => row.content === "Clean C words.")))
      const beforeStop = h.requests.flatMap(request => request.body.events ?? [])
      expect(beforeStop.filter(row => row.role === "user").map(row => [row.content, row.status])).toEqual([
        ["Previously submitted words.", "complete"],
        ["[Turn timing uncertain; combined speech, text retained in received order.]\nDelayed A words. B words.", "complete"],
        ["Clean C words.", "complete"],
      ])
      expect(h.requests.some(request => request.url.endsWith("/end"))).toBe(false)

      admitRequest(h, mode)
      completeTurn(h, "", "Answer D without its input transcription.")
      expect(h.requests.flatMap(request => request.body.events ?? []).some(row => row.event_kind === "transcript_gap")).toBe(false)
      await h.controller.stop()
      const rows = h.requests.flatMap(request => request.body.events ?? [])
      expect(rows.filter(row => row.role === "user" && row.event_kind === "transcript_gap"))
        .toMatchObject([{content: "Transcript unavailable."}])
      expect(rows.filter(row => row.role === "user" && row.event_kind === "transcript").map(row => row.content))
        .toEqual(beforeStop.filter(row => row.role === "user").map(row => row.content))
      expect(rows.filter(row => row.role === "assistant").map(row => row.content)).toEqual([
        "Previously submitted answer.", "Answer A before its transcription.",
        "Answer B at the clean native boundary.", "Clean C answer.", "Answer D without its input transcription.",
      ])
      expect(h.persistenceErrors).toContain("Some spoken words could not be transcribed")
      expect(JSON.stringify(first.body)).toBe(submitted)
      for (const row of rows.filter(row => originals.has(row.event_id))) {
        expect(JSON.stringify(row)).toBe(originals.get(row.event_id))
      }
      expect(h.errors).toEqual([])
    } finally {
      await h.controller.stop()
    }
  })

  test.each(["older-response", "background-photo"] as const)("%s completion after B END cannot seal an uncertain speech group", async boundary => {
    const storage = new FakeStorage()
    const h = harness({storage})
    await start(h)
    try {
      admitRequest(h, "continuous")
      if (boundary === "older-response") {
        h.sockets[0].message({serverContent: {
          inputTranscription: {text: "A words. "}, outputTranscription: {text: "An older A response."},
          modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]},
        }})
      } else {
        completeTurn(h, "", "A response before its transcription.")
        await h.controller.sendImage({imageId: "non-speech-boundary", mimeType: "image/png", data: "AQID"})
      }
      admitRequest(h, "continuous")
      if (boundary === "background-photo") {
        h.sockets[0].message({serverContent: {inputTranscription: {text: "A words. "}}})
      }
      h.sockets[0].message({serverContent: {inputTranscription: {text: "B words."}}})
      if (boundary === "background-photo") {
        saveCaption(h.sockets[0], "non-speech-boundary", "A fictional amber star.")
        await waitFor(() => h.finalizations.length === 1)
      }
      h.sockets[0].message({serverContent: {turnComplete: true}})
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(h.requests.some(request => request.url.endsWith("/transcripts/append"))).toBe(false)
      const drafts = JSON.parse(storage.values.get(JOURNAL_KEY)!).draftTranscripts
      expect(drafts[0]).toMatchObject({content: "A words. B words.", speech: {waiting: true, uncertain: true, ended: true}})
      await h.controller.stop()
      const rows = h.requests.flatMap(request => request.body.events ?? [])
      expect(rows.filter(row => row.role === "user" && row.event_kind === "transcript").map(row => row.content))
        .toEqual(["[Turn timing uncertain; combined speech, text retained in received order.]\nA words. B words."])
      expect(rows.some(row => row.event_kind === "transcript_gap")).toBe(false)
      expect(h.errors).toEqual([])
    } finally {
      await h.controller.stop()
    }
  })

  test("a lost append ACK and later ambiguous draft never change previously submitted events", async () => {
    const storage = new FakeStorage()
    const options = {storage, appendAckLost: true}
    const h = harness(options)
    await start(h)
    completeTurn(h, "Already submitted question.", "Already submitted answer.")
    await waitFor(() => h.persistenceErrors.includes("Transcript sync failed; retrying"))
    const first = h.requests.find(request => request.url.endsWith("/transcripts/append"))!
    const submitted = JSON.stringify(first.body)
    const originals = new Map(first.body.events.map((event: any) => [event.event_id, JSON.stringify(event)]))
    for (const [index, text] of ["Delayed first. ", "Delayed second."].entries()) {
      h.sockets[0].message({voiceActivity: {type: "ACTIVITY_START"}})
      h.sockets[0].message({voiceActivity: {type: "ACTIVITY_END"}})
      const reply = {serverContent: {outputTranscription: {text: "Later answer."},
        modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}, turnComplete: true}}
      if (index === 0) h.sockets[0].message(reply)
      h.sockets[0].message({serverContent: {inputTranscription: {text}}})
      if (index === 1) h.sockets[0].message(reply)
    }
    await waitFor(() => h.requests.filter(request => request.url.endsWith("/transcripts/append")).length >= 2)
    options.appendAckLost = false
    await h.controller.stop()
    expect(JSON.stringify(first.body)).toBe(submitted)
    const rows = h.requests.flatMap(request => request.body.events ?? [])
    for (const row of rows.filter(row => originals.has(row.event_id))) {
      expect(JSON.stringify(row)).toBe(originals.get(row.event_id))
    }
    expect(rows.some(row => row.content ===
      "[Turn timing uncertain; combined speech, text retained in received order.]\nDelayed first. Delayed second.")).toBe(true)
    expect(h.errors).toEqual([])
  })

  test.each(["reservation", "partial-text"] as const)("cold recovery seals a crashed %s before admitting new speech", async crash => {
    const storage = new FakeStorage()
    const old = harness({storage})
    await start(old)
    old.sockets[0].message({voiceActivity: {type: "ACTIVITY_START"}})
    if (crash === "partial-text") {
      old.sockets[0].message({serverContent: {inputTranscription: {text: "Retained unfinished words."}}})
    } else {
      old.sockets[0].message({serverContent: {outputTranscription: {text: "An answer before the crash."},
        modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}, turnComplete: true}})
    }
    await waitFor(() => {
      const drafts = JSON.parse(storage.values.get(JOURNAL_KEY) || "{}").draftTranscripts
      return drafts?.[0]?.speech?.waiting &&
        (crash === "partial-text" ? drafts[0].content === "Retained unfinished words." : drafts.length === 2)
    })
    const restored = new FakeStorage()
    restored.values.set(JOURNAL_KEY, storage.values.get(JOURNAL_KEY)!)
    await old.controller.stop()
    const next = harness({storage: restored})
    await start(next)
    next.sockets[0].message({voiceActivity: {type: "ACTIVITY_START"}})
    next.sockets[0].message({voiceActivity: {type: "ACTIVITY_END"}})
    completeTurn(next, "Entirely new speech.", "A new answer.", true)
    await next.controller.stop()
    const rows = next.requests.flatMap(request => request.body.events ?? [])
    expect(rows.filter(row => row.role === "user" && row.event_kind === "transcript").map(row => row.content))
      .toEqual(crash === "partial-text" ? ["Retained unfinished words.", "Entirely new speech."] : ["Entirely new speech."])
    if (crash === "reservation") {
      expect(rows.some(row => row.event_kind === "transcript_gap" && row.role === "user")).toBe(true)
      expect(next.persistenceErrors).toContain("Some spoken words could not be transcribed")
      expect(next.persistenceErrors.at(-1)).toBe("Some spoken words could not be transcribed")
    } else expect(rows.find(row => row.content === "Retained unfinished words.").status).toBe("interrupted")
    expect(next.errors).toEqual([])
  })

  test.each([false, true])("a v2 draft-only backup preserves words unless history resets (reset=%s)", async reset => {
    const storage = new FakeStorage()
    const old = harness({storage})
    await start(old)
    if (reset) old.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "reset-history-handle"}})
    old.sockets[0].message({voiceActivity: {type: "ACTIVITY_START"}})
    old.sockets[0].message({serverContent: {inputTranscription: {text: "Words from replaced history."}}})
    await waitFor(() => JSON.parse(storage.values.get(JOURNAL_KEY) || "{}").draftTranscripts?.[0]?.content ===
      "Words from replaced history.")
    const raw = storage.values.get(JOURNAL_KEY)!
    expect(JSON.parse(raw).version).toBe(2)
    expect(journalSoulId(raw, CONFIG)).toBe(CONFIG.soulId)
    expect(JSON.parse(raw).pendingTranscripts).toEqual([])
    expect(JSON.parse(raw).nextTranscriptSequence).toBe(41)
    const restored = new FakeStorage()
    restored.values.set(JOURNAL_KEY, raw)
    await old.controller.stop()
    const next = harness({storage: restored, startSequence: reset ? 39 : 41})
    await start(next)
    expect(JSON.parse(next.sockets[0].sent[0])).toEqual({setup: {sessionResumption: {}}})
    if (reset) {
      expect(JSON.parse(restored.values.get(RECOVERED_CHATS_KEY)!)).toEqual([raw])
      expect(next.requests.some(request => request.url.endsWith("/transcripts/append"))).toBe(false)
    } else {
      await waitFor(() => next.requests.some(request => request.body.events?.some(
        (row: any) => row.content === "Words from replaced history.")))
      expect(restored.values.has(RECOVERED_CHATS_KEY)).toBe(false)
    }
    completeTurn(next, "New history question.", "New history answer.")
    await next.controller.stop()
    expect(next.requests.flatMap(request => request.body.events ?? []).map(row => [row.sequence, row.content]))
      .toEqual(reset ? [[39, "New history question."], [40, "New history answer."]] :
        [[41, "Words from replaced history."], [42, "New history question."], [43, "New history answer."]])
    expect(next.errors).toEqual([])
  })

  test("admitted missing speech produces a gap only at Stop even without an assistant reply", async () => {
    const h = harness({storage: new FakeStorage()})
    await start(h)
    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_START"}})
    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_END"}})
    expect(h.requests.some(request => request.url.endsWith("/transcripts/append"))).toBe(false)
    expect(h.persistenceErrors).not.toContain("Some spoken words could not be transcribed")
    await h.controller.stop()
    expect(h.requests.flatMap(request => request.body.events ?? [])).toEqual([
      {event_id: "sitting-1:41", sequence: 41, event_kind: "transcript_gap", role: "user", content: "Transcript unavailable."},
    ])
    expect(h.persistenceErrors.at(-1)).toBe("Some spoken words could not be transcribed")
    expect(h.audio).toEqual([])
    expect(h.errors).toEqual([])
  })

  test.each(["", " \n "])("raw silence without speech admission creates no fake gaps (%j)", async text => {
    const h = harness({storage: new FakeStorage()})
    await start(h)
    h.sockets[0].message({serverContent: {inputTranscription: {text}, outputTranscription: {text}, turnComplete: true}})
    await h.controller.stop()
    expect(h.requests.some(request => request.url.endsWith("/transcripts/append"))).toBe(false)
    expect(h.persistenceErrors).not.toContain("Some spoken words could not be transcribed")
    expect(h.audio).toEqual([])
    expect(h.errors).toEqual([])
  })

  test("resumed reconnect leaves late speech unresolved until Stop", async () => {
    const storage = new FakeStorage()
    const h = harness({storage})
    await start(h)
    h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "late-speech-handle"}})
    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_START"}})
    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_END"}})
    h.sockets[0].message({serverContent: {outputTranscription: {text: "An answer before reconnect."},
      modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}, turnComplete: true}})
    h.sockets[0].close()
    await waitFor(() => h.sockets.length === 2)
    h.sockets[1].open()
    expect(JSON.parse(h.sockets[1].sent[0])).toEqual({setup: {sessionResumption: {handle: "late-speech-handle"}}})
    h.sockets[1].message({setupComplete: {}})
    await waitFor(() => h.reconnecting.at(-1) === false)
    h.sockets[1].message({serverContent: {inputTranscription: {text: "Late words after reconnect."}}})
    await waitFor(() => JSON.parse(storage.values.get(JOURNAL_KEY) || "{}").draftTranscripts?.[0]?.content ===
      "Late words after reconnect.")
    expect(h.requests.some(request => request.url.endsWith("/transcripts/append"))).toBe(false)
    expect(JSON.parse(storage.values.get(JOURNAL_KEY)!).draftTranscripts[0].speech.waiting).toBe(true)
    await h.controller.stop()
    expect(h.requests.flatMap(request => request.body.events ?? []).map(row => [row.role, row.content])).toEqual([
      ["user", "Late words after reconnect."], ["assistant", "An answer before reconnect."],
    ])
    expect(h.errors).toEqual([])
  })

  test("an unresolved speech draft permits durable photo ACK before any timeline append", async () => {
    const storage = new FakeStorage()
    const history: NonNullable<Parameters<typeof harness>[0]>["history"] = []
    const h = harness({storage, history})
    await start(h)
    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_START"}})
    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_END"}})
    h.sockets[0].message({serverContent: {outputTranscription: {text: "A reply with delayed input."},
      modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}, turnComplete: true}})
    await h.controller.sendImage({imageId: "late-photo", mimeType: "image/png", data: "AQID"})
    saveCaption(h.sockets[0], "late-photo", "A fictional striped oval.")
    await waitFor(() => h.sockets[0].sent.some(value => JSON.parse(value).toolResponse?.functionResponses?.some(
      (response: any) => response.id === "caption-late-photo" && response.response.durable === true)))
    expect(h.requests.some(request => request.url.endsWith("/transcripts/append"))).toBe(false)
    expect(history).toEqual([])
    const upload = h.requests.findIndex(request => request.url.endsWith("/snapshot"))
    const finalize = h.requests.findIndex(request => request.url.endsWith("/snapshot/finalize"))
    expect(upload).toBeGreaterThanOrEqual(0)
    expect(finalize).toBeGreaterThan(upload)
    expect(h.requests[finalize].body).toEqual({user_id: CONFIG.userId, soul_id: CONFIG.soulId,
      image_id: "late-photo", caption: "A fictional striped oval.", caption_event_id: "sitting-1:photo:late-photo"})
    await waitFor(() => JSON.parse(storage.values.get(JOURNAL_KEY)!).pendingImage === null)
    expect(JSON.parse(storage.values.get(JOURNAL_KEY)!).draftTranscripts.map((draft: any) => draft.event_kind))
      .toEqual(["transcript", "transcript", "image", "photo_caption"])
    h.sockets[0].message({serverContent: {inputTranscription: {text: "The delayed photo question."}}})
    await h.controller.stop()
    expect(history.map(row => [row.event_kind, row.content])).toEqual([
      ["transcript", "The delayed photo question."], ["transcript", "A reply with delayed input."],
      ["image", "Shared a photo."], ["photo_caption", "A fictional striped oval."],
    ])
    expect(history.filter(row => ["image", "photo_caption"].includes(row.event_kind)).map(row => row.event_id))
      .toEqual(["sitting-1:43", "sitting-1:44"])
    expect(h.errors).toEqual([])
  })

  test("chunks uncertain combined Unicode speech within 16000 characters without losing words or prefix", async () => {
    const fragments = ["a" + " ".repeat(16_001), "\u{1f642}".repeat(16_001) + " z"]
    const h = harness({storage: new FakeStorage()})
    await start(h)
    for (const [index, text] of fragments.entries()) {
      h.sockets[0].message({voiceActivity: {type: "ACTIVITY_START"}})
      h.sockets[0].message({voiceActivity: {type: "ACTIVITY_END"}})
      const reply = {serverContent: {outputTranscription: {text: "A fictional answer."},
        modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}, turnComplete: true}}
      if (index === 0) h.sockets[0].message(reply)
      h.sockets[0].message({serverContent: {inputTranscription: {text}}})
      if (index === 1) h.sockets[0].message(reply)
    }
    await h.controller.stop()
    const rows = h.requests.flatMap(request => request.body.events ?? [])
    const users = rows.filter(row => row.role === "user")
    expect(users.length).toBeGreaterThan(2)
    expect(users.every(row => Array.from(row.content).length <= 16_000)).toBe(true)
    expect(users.map(row => row.content).join("")).toBe(
      "[Turn timing uncertain; combined speech, text retained in received order.]\n" + fragments.join(""))
    expect(new Set(rows.map(row => row.event_id)).size).toBe(rows.length)
    expect(rows.map(row => row.sequence)).toEqual(rows.map((_, index) => 41 + index))
    expect(h.errors).toEqual([])
  })

  test.each(["alone", "unheard output", "heard reply"] as const)("orphan input is uncertain when co-delivered with %s", async packet => {
    const h = harness({storage: new FakeStorage()})
    await start(h)
    completeTurn(h, "An already settled question.", "Its settled answer.")
    await waitFor(() => h.requests.some(request => request.url.endsWith("/transcripts/append")))
    h.sockets[0].message({serverContent: {inputTranscription: {text: "Orphan words."},
      ...(packet !== "alone" ? {outputTranscription: {text: "Another reply."}, turnComplete: true} : {}),
      ...(packet === "heard reply" ? {modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}} : {}),
    }})
    await h.controller.stop()
    expect(h.requests.flatMap(request => request.body.events ?? []).filter(row => row.role === "user")
      .map(row => row.content)).toEqual(["An already settled question.",
        "[Turn timing uncertain; combined speech, text retained in received order.]\nOrphan words."])
    expect(h.requests.flatMap(request => request.body.events ?? []).filter(row => row.role === "user")
      .map(row => row.status)).toEqual(["complete", "complete"])
    expect(h.requests.flatMap(request => request.body.events ?? []).filter(row => row.role === "assistant")
      .map(row => row.content)).toEqual(packet === "heard reply" ? ["Its settled answer.", "Another reply."] : ["Its settled answer."])
    expect(h.errors).toEqual([])
  })

  test.each(["continuous", "manual"] as const)("%s preserves late fragmented speech before its answer", async mode => {
    const h = harness({storage: new FakeStorage()})
    await start(h, mode)
    if (mode === "manual") h.controller.sendActivity(["AAAA"], "phone")
    else h.controller.sendAudio("AAAA", "phone")
    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_START", audioOffset: "0s"}})
    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_END", audioOffset: "1s"}})
    h.sockets[0].message({serverContent: {modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]},
      outputTranscription: {text: "The fictional badge is blue."}, turnComplete: true}})
    expect(h.errors).toEqual([])
    h.sockets[0].message({serverContent: {inputTranscription: {text: "What color "}}})
    h.sockets[0].message({serverContent: {inputTranscription: {text: "is the badge?"}}})
    expect(h.errors).toEqual([])
    await h.controller.stop()
    const rows = h.requests.filter(request => request.url.endsWith("/transcripts/append"))
      .flatMap(request => request.body.events)
    expect(rows.map(row => [row.role, row.content])).toEqual([
      ["user", "What color is the badge?"], ["assistant", "The fictional badge is blue."],
    ])
    expect(rows[0].mic_source).toBe("phone")
    expect(rows.every(row => row.event_kind === "transcript")).toBe(true)
  })

  test("overlapping late speech is combined with uncertain timing, not assigned to a later reply", async () => {
    const h = harness({storage: new FakeStorage()})
    await start(h)
    for (const answer of ["A fictional blue square.", "A fictional red triangle."]) {
      h.sockets[0].message({voiceActivity: {type: "ACTIVITY_START"}})
      h.sockets[0].message({voiceActivity: {type: "ACTIVITY_END"}})
      h.sockets[0].message({serverContent: {modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]},
        outputTranscription: {text: answer}, turnComplete: true}})
    }
    h.sockets[0].message({serverContent: {inputTranscription: {text: "First question. "}}})
    h.sockets[0].message({serverContent: {inputTranscription: {text: "Second question."}}})
    expect(h.errors).toEqual([])
    await h.controller.stop()
    const rows = h.requests.filter(request => request.url.endsWith("/transcripts/append"))
      .flatMap(request => request.body.events)
    const users = rows.filter(row => row.role === "user")
    expect(users).toHaveLength(1)
    expect(users[0].content).toContain("Turn timing uncertain")
    expect(users[0].content).toContain("text retained in received order")
    expect(users[0].content).toEndWith("First question. Second question.")
    expect(rows.filter(row => row.role === "assistant").map(row => row.content))
      .toEqual(["A fictional blue square.", "A fictional red triangle."])
    expect(rows.some(row => row.event_kind === "transcript_gap")).toBe(false)
  })

  test("production traces contain lengths, never transcripts or recalled memory", async () => {
    const previousEnv = process.env.NODE_ENV
    const logs = spyOn(console, "info").mockImplementation(() => {})
    const h = harness({recallBody: {ok: true, context: "Private fictional memory", retrieve_ms: 1}})
    try {
      process.env.NODE_ENV = "production"
      await start(h)
      completeTurn(h, "Private fictional input", "Private fictional output")
      h.sockets[0].message({toolCall: {
        functionCalls: [{id: "trace-check", name: "recall_memory", args: {query: "Private fictional query"}}],
      }})
      await waitFor(() => logs.mock.calls.some(([event]) => String(event).endsWith("recall.end")))
      const detail = (event: string) => logs.mock.calls.find(([line]) => String(line).endsWith(event))?.[1]
      expect(detail("provider.input_transcription")).toBeUndefined()
      expect(detail("provider.output_transcription")).toBeUndefined()
      expect(detail("recall.begin")).toEqual({id: "trace-check", queryLength: "Private fictional query".length})
      expect(detail("recall.end")).toMatchObject({contextLength: "Private fictional memory".length})
      expect(JSON.stringify(logs.mock.calls)).not.toContain("Private fictional")
    } finally {
      await h.controller.stop(false)
      if (previousEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previousEnv
      logs.mockRestore()
    }
  })
  test("rejects recovery belonging to another soul without sending its contents", async () => {
    const storage = new FakeStorage()
    storage.values.set("openalma:gemini-session-v1", JSON.stringify({
      version: 1,
      scope: {userId: CONFIG.userId, soulId: "Other Fictional Soul", deviceSessionId: CONFIG.deviceSessionId},
      resumption: {handle: "other-soul-handle", updatedAt: Date.now()},
      pendingTranscripts: [],
      pendingImage: {imageId: "other-photo", mediaRef: "mentra_media/test-phone/other-photo.png",
        providerSent: false, captureAfterCurrent: false, generation: 1, sessionId: "old-sitting"},
    }))
    const h = harness({storage})
    await start(h)
    expect(h.requests.some((r) => r.url.endsWith("/snapshot/replay"))).toBe(false)
    expect(h.sockets[0].sent.join(" ")).not.toContain("other-soul-handle")
    expect(JSON.parse(storage.values.get(RECOVERED_CHATS_KEY)!)[0]).toContain("other-soul-handle")
    await h.controller.stop()
  })
  test.each([200, 503])("caption preview waits for durable acceptance before green (%i)", async status => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {release = resolve})
    const h = harness({storage: new FakeStorage(), finalizeGates: [gate], finalizeStatuses: [status]})
    await start(h)
    try {
      await h.controller.sendImage({imageId: "caption-preview", mimeType: "image/png", data: "AQID"})
      saveCaption(h.sockets[0], "caption-preview", "A fictional green triangle.")
      await waitFor(() => h.photoCaptions.length === 1)
      expect(h.photoCaptions).toEqual([{imageId: "caption-preview", caption: "A fictional green triangle.",
        durable: false, acknowledgmentOnly: false}])
      expect(h.finalizations).toEqual([])
      release()
      await waitFor(() => h.finalizations.length === 1)
      await waitFor(() => status === 200 ? h.photoCaptions.length === 2 : h.photoRetryChanges.at(-1) === true)
      expect(h.photoCaptions.filter(caption => caption.durable)).toHaveLength(status === 200 ? 1 : 0)
      if (status === 200) expect(h.photoCaptions[1]).toMatchObject({imageId: "caption-preview", acknowledgmentOnly: true})
    } finally {
      release()
      await h.controller.stop()
    }
  })

  test("snapshots, sends, journals, acknowledges, then finalizes one image", async () => {
    const storage = new FakeStorage()
    const h = harness({storage})
    await start(h)
    h.controller.sendAudio("AAAA", "glasses")

    await h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    expect(h.requests.find((request) => request.url.endsWith("/snapshot"))?.body).toEqual({
      user_id: "Test User",
      soul_id: "Test Soul",
      image_id: "image-1",
      mime_type: "image/png",
      data: "AQID",
    })
    expect(h.sockets[0].sent.slice(-1).map(value => JSON.parse(value))).toEqual([photoTurn("image-1")])
    expect(h.sockets[0].sent.some(value => JSON.parse(value).realtimeInput?.video || JSON.parse(value).realtimeInput?.text)).toBe(false)
    expect(h.sockets[0].sent.some(value => textTurn(JSON.parse(value)))).toBe(false)

    saveCaption(h.sockets[0], "image-1", "A fictional blue square.")
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot/finalize")))
    await waitFor(() => h.sockets[0].sent.some(value => JSON.parse(value).toolResponse))
    expect(h.sockets[0].sent.flatMap(value => JSON.parse(value).toolResponse?.functionResponses ?? []))
      .toContainEqual({id: "caption-image-1", name: "save_photo_caption",
        response: {ok: true, durable: true}, scheduling: "SILENT"})
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
      event_kind: "photo_caption",
      role: "assistant",
      content: "A fictional blue square.",
      media_ref: "mentra_media/test-phone/image-1.png",
    })
    expect(h.requests.find((request) => request.url.endsWith("/snapshot/finalize"))?.body).toEqual({
      user_id: "Test User",
      soul_id: "Test Soul",
      image_id: "image-1",
      caption: "A fictional blue square.",
      caption_event_id: "sitting-1:photo:image-1",
    })
    await h.controller.stop()
  })

  test.each(["lost-ack", "rekey", "advanced"] as const)("durable photo receipt survives %s transcript recovery without refiling", async recovery => {
    const storage = new FakeStorage()
    const history: NonNullable<Parameters<typeof harness>[0]>["history"] = []
    const h = harness({storage, history,
      appendStatuses: recovery === "lost-ack" ? [] : Array(100).fill(503),
      appendAckLost: recovery === "lost-ack"})
    await start(h)
    await h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    saveCaption(h.sockets[0], "image-1", "A fictional blue square.")
    await waitFor(() => h.finalizations.length === 1)
    await h.controller.stop()
    const journal = JSON.parse(storage.values.get(JOURNAL_KEY)!)
    expect(journal.pendingImage).toBeNull()
    expect(journal.pendingTranscripts.find((event: any) => event.event_kind === "photo_caption").event_id)
      .toBe("sitting-1:42")
    expect(h.finalizations).toEqual([{ok: true, durable: true, queued: true}])
    const recovered = harness({storage, history, startBody: {
      session_id: "replacement-sitting", next_transcript_sequence: recovery === "rekey" ? 41 : 45,
      ephemeral_token: "ephemeral/test", websocket: {api_version: "v1beta",
        method: "BidiGenerateContentConstrained", input_audio_rate_hz: 16000, output_audio_rate_hz: 24000},
      lease_seconds: 90, session_warning_seconds: 0,
    }})
    await start(recovered)
    await recovered.controller.stop()
    expect(recovered.requests.some(request => request.url.endsWith("/snapshot/finalize") ||
      request.url.endsWith("/snapshot/replay"))).toBe(false)
    const captions = recovered.requests.flatMap(request => request.body.events ?? [])
      .filter(event => event.event_kind === "photo_caption")
    expect(captions.map(event => event.event_id)).toEqual(recovery === "rekey" ? ["replacement-sitting:42"] : [])
    expect(recovered.errors).toEqual([])
  })

  test.each(["missing", "invalid"] as const)("a %s caption call at native completion exposes photo Retry without losing the original", async result => {
    const storage = new FakeStorage()
    const h = harness({storage})
    await start(h)
    try {
      await h.controller.sendImage({imageId: "skipped-caption", mimeType: "image/png", data: "AQID"})
      expect(h.sockets[0].sent.filter(value => photoInput(JSON.parse(value)))).toHaveLength(1)
      if (result === "invalid") {
        saveCaption(h.sockets[0], "skipped-caption", " ")
        await waitFor(() => functionResponses(h.sockets[0]).length === 1)
        expect(functionResponses(h.sockets[0])[0]).toMatchObject({response: {ok: false, status: "invalid"}, scheduling: "SILENT"})
      }
      h.sockets[0].message({serverContent: {outputTranscription: {text: "Unspoken photo reasoning."}, turnComplete: true}})
      await waitFor(() => h.photoRetryChanges.at(-1) === true)
      expect(h.persistenceErrors).toContain(PHOTO_RETRY_MESSAGE)
      await waitFor(() => JSON.parse(storage.values.get(JOURNAL_KEY)!).pendingImage?.retryRequested === true)
      expect(JSON.parse(storage.values.get(JOURNAL_KEY)!).pendingImage).toMatchObject({
        imageId: "skipped-caption", mediaRef: "mentra_media/test-phone/skipped-caption.png", retryRequested: true,
      })
      expect(h.requests.some(request => request.url.endsWith("/snapshot/finalize"))).toBe(false)
      expect(h.requests.some(request => request.url.endsWith("/snapshot/replay"))).toBe(false)
      expect(h.audio).toEqual([])
      expect(h.errors).toEqual([])
      if (result === "missing") {
        await h.controller.retryImage()
        expect(h.requests.filter(request => request.url.endsWith("/snapshot/replay")).map(request => request.body.image_id))
          .toEqual(["skipped-caption"])
        expect(h.sockets[0].sent.filter(value => photoInput(JSON.parse(value)))).toHaveLength(2)
        expect(h.sockets[0].sent.flatMap(value => photoTask(JSON.parse(value)) ?? []))
          .toEqual(Array(2).fill(`image_id: skipped-caption\n${PHOTO_CAPTION_INSTRUCTION}`))
        expect(h.photoRetryChanges.at(-1)).toBe(false)
      }
      saveCaption(h.sockets[0], "skipped-caption", "A late fictional blue square.", "late-valid-caption")
      h.sockets[0].message({serverContent: {turnComplete: true}})
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "late-valid-caption"))
      expect(functionResponses(h.sockets[0]).find(response => response.id === "late-valid-caption"))
        .toMatchObject({response: {ok: true, durable: true}, scheduling: "SILENT"})
      expect(h.photoRetryChanges.at(-1)).toBe(false)
      expect(h.persistenceErrors.at(-1)).toBeNull()
      expect(h.requests.filter(request => request.url.endsWith("/snapshot/finalize")).map(request => request.body))
        .toEqual([expect.objectContaining({image_id: "skipped-caption", caption: "A late fictional blue square."})])
      expect(h.requests.filter(request => request.url.endsWith("/snapshot"))).toHaveLength(1)
      expect(h.requests.filter(request => request.url.endsWith("/snapshot/replay"))).toHaveLength(result === "missing" ? 1 : 0)
      expect(h.sockets[0].sent.filter(value => photoInput(JSON.parse(value)))).toHaveLength(result === "missing" ? 2 : 1)
      expect(h.requests.flatMap(request => request.body.events ?? []).filter(row => row.event_kind === "photo_caption"))
        .toMatchObject([{content: "A late fictional blue square.", media_ref: "mentra_media/test-phone/skipped-caption.png"}])
      await h.controller.discardImage()
      expect(h.photoRetryChanges.at(-1)).toBe(false)
      await h.controller.sendImage({imageId: "next-photo", mimeType: "image/png", data: "BAUG"})
      expect(h.sockets[0].sent.filter(value => photoInput(JSON.parse(value)))).toHaveLength(result === "missing" ? 3 : 2)
    } finally {
      await h.controller.stop()
    }
  })

  test("caption tools bind the scoped original and never overwrite accepted same-ID captions", async () => {
    const storage = new FakeStorage()
    const history: NonNullable<Parameters<typeof harness>[0]>["history"] = []
    const config = {...CONFIG, soulId: "Another Test Soul"}
    const h = harness({storage, history, config})
    await start(h)
    await h.controller.sendImage({imageId: "square", mimeType: "image/png", data: "AQID"})
    saveCaption(h.sockets[0], "wrong-original", "A fictional red triangle.", "wrong-image")
    await waitFor(() => h.sockets[0].sent.some(value => JSON.parse(value).toolResponse))
    expect(history.filter(event => event.event_kind === "photo_caption")).toEqual([])
    expect(h.requests.some(request => request.url.endsWith("/snapshot/finalize"))).toBe(false)
    const results = () => h.sockets[0].sent.flatMap(value => JSON.parse(value).toolResponse?.functionResponses ?? [])
    let release!: () => void
    storage.setGate = new Promise<void>(resolve => { release = resolve })
    const writes = storage.setCalls
    try {
      saveCaption(h.sockets[0], "square", "A fictional blue square.", "first-caption")
      await waitFor(() => storage.setCalls > writes)
      saveCaption(h.sockets[0], "square", "A fictional blue square.", "concurrent-caption")
      h.sockets[0].message({serverContent: {turnComplete: true}})
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(results().some(result => ["first-caption", "concurrent-caption"].includes(result.id))).toBe(false)
      expect(history.filter(event => event.event_kind === "photo_caption")).toEqual([])
      expect(h.requests.some(request => request.url.endsWith("/snapshot/finalize"))).toBe(false)
    } finally {
      storage.setGate = null
      release()
    }
    await waitFor(() => results().filter(result => ["first-caption", "concurrent-caption"].includes(result.id)).length === 2)
    for (const id of ["first-caption", "concurrent-caption"]) {
      expect(results().find(result => result.id === id)).toMatchObject({response: {ok: true, durable: true}, scheduling: "SILENT"})
    }
    expect(h.requests.filter(request => request.url.endsWith("/snapshot/finalize"))).toHaveLength(1)
    const accepted = history.filter(event => event.event_kind === "photo_caption")
    expect(accepted).toHaveLength(1)
    expect(accepted[0]).toMatchObject({role: "assistant", content: "A fictional blue square.",
      media_ref: "mentra_media/test-phone/square.png"})
    expect(accepted[0]).not.toHaveProperty("status")
    const requestCount = h.requests.length
    saveCaption(h.sockets[0], "square", "A fictional blue square.", "same-caption")
    saveCaption(h.sockets[0], "square", "A fictional red triangle.", "conflicting-caption")
    await waitFor(() => results().some(result => result.id === "conflicting-caption"))
    expect(results().find(result => result.id === "same-caption")).toMatchObject({
      response: {ok: true, durable: true}, scheduling: "SILENT",
    })
    expect(results().find(result => result.id === "conflicting-caption")).toMatchObject({
      response: {ok: false, durable: false, status: "conflict"}, scheduling: "SILENT",
    })
    expect(h.requests).toHaveLength(requestCount)
    expect(history.filter(event => event.event_kind === "photo_caption")).toEqual(accepted)
    h.sockets[0].message({serverContent: {turnComplete: true}})
    await h.controller.sendImage({imageId: "triangle", mimeType: "image/png", data: "BAUG"})
    saveCaption(h.sockets[0], "triangle", "A fictional red triangle.", "second-photo")
    await waitFor(() => results().some(result => result.id === "second-photo"))
    expect(history.filter(event => event.event_kind === "photo_caption").map(event => [event.media_ref, event.content]))
      .toEqual([["mentra_media/test-phone/square.png", "A fictional blue square."],
        ["mentra_media/test-phone/triangle.png", "A fictional red triangle."]])
    const filings = h.requests.filter(request => request.url.endsWith("/snapshot/finalize"))
    expect(filings).toHaveLength(2)
    expect(filings.every(request => request.body.user_id === config.userId && request.body.soul_id === config.soulId)).toBe(true)
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("a second stored photo waits for the first caption's native completion before replay delivery", async () => {
    const storage = new FakeStorage()
    const h = harness({storage})
    await start(h)
    const images = () => h.sockets[0].sent.flatMap(value => photoInput(JSON.parse(value)) ?? [])
    try {
      await h.controller.sendImage({imageId: "boundary-square", mimeType: "image/png", data: "AQID"})
      saveCaption(h.sockets[0], "boundary-square", "A fictional blue square.")
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "caption-boundary-square"))
      expect(functionResponses(h.sockets[0]).find(response => response.id === "caption-boundary-square"))
        .toMatchObject({response: {ok: true, durable: true}, scheduling: "SILENT"})

      await h.controller.sendImage({imageId: "boundary-triangle", mimeType: "image/png", data: "BAUG"})
      expect(h.requests.filter(request => request.url.endsWith("/snapshot")).map(request => request.body.image_id))
        .toEqual(["boundary-square", "boundary-triangle"])
      expect(images()).toEqual([{data: "AQID", mimeType: "image/png"}])
      expect(JSON.parse(storage.values.get(JOURNAL_KEY)!).pendingImage).toMatchObject({
        imageId: "boundary-triangle", mediaRef: "mentra_media/test-phone/boundary-triangle.png", providerSent: false,
      })
      h.sockets[0].message({serverContent: {generationComplete: true}})
      expect(images()).toHaveLength(1)
      expect(h.requests.some(request => request.url.endsWith("/snapshot/replay"))).toBe(false)

      h.sockets[0].message({serverContent: {turnComplete: true}})
      await waitFor(() => images().length === 2)
      expect(h.requests.filter(request => request.url.endsWith("/snapshot/replay")).map(request => request.body.image_id))
        .toEqual(["boundary-triangle"])
      expect(h.photoRetryChanges).not.toContain(true)
      const tasks = h.sockets[0].sent.flatMap(value => photoTask(JSON.parse(value)) ?? [])
      expect(tasks).toEqual([
        `image_id: boundary-square\n${PHOTO_CAPTION_INSTRUCTION}`,
        `image_id: boundary-triangle\n${PHOTO_CAPTION_INSTRUCTION}`,
      ])
      saveCaption(h.sockets[0], "boundary-triangle", "A fictional red triangle.")
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "caption-boundary-triangle"))
      expect(functionResponses(h.sockets[0]).find(response => response.id === "caption-boundary-triangle"))
        .toMatchObject({response: {ok: true, durable: true}, scheduling: "SILENT"})
      h.sockets[0].message({serverContent: {turnComplete: true}})
      expect(h.requests.filter(request => request.url.endsWith("/snapshot/finalize"))
        .map(request => [request.body.image_id, request.body.caption]))
        .toEqual([["boundary-square", "A fictional blue square."], ["boundary-triangle", "A fictional red triangle."]])
      expect(h.audio).toEqual([])
      expect(h.errors).toEqual([])
    } finally {
      await h.controller.stop()
    }
  })

  test.each(["queued", "running", "complete", "failed", "discarded"])(
    "cold recovery reuses the accepted %s receipt without recaption or refiling", async status => {
      const storage = new FakeStorage()
      storage.values.set(JOURNAL_KEY, JSON.stringify({version: 1,
        scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
        resumption: null, pendingTranscripts: [], pendingImage: {
          imageId: "receipt-photo", mediaRef: "mentra_media/test-phone/receipt-photo.png",
          providerSent: true, captureAfterCurrent: false, generation: 1, sessionId: "old-sitting",
        }}))
      const h = harness({storage, replayBodies: [{mime_type: "image/png", data: "AQID",
        media_ref: "mentra_media/test-phone/receipt-photo.png", filing: {
          caption: "A fictional amber star.", caption_event_id: "old-sitting:photo:receipt-photo", status,
        }}]})
      await start(h)
      await waitFor(() => storage.values.get(JOURNAL_KEY) === "")
      expect(h.requests.filter(request => request.url.endsWith("/snapshot/replay"))).toHaveLength(1)
      expect(h.requests.some(request => /\/(finalize|retry|append)$/.test(request.url))).toBe(false)
      expect(h.sockets[0].sent.map(value => JSON.parse(value))).toEqual([{setup: {sessionResumption: {}}}])
      expect(h.photoCaptions).toEqual([{imageId: "receipt-photo", caption: "A fictional amber star.",
        durable: true, acknowledgmentOnly: false}])
      saveCaption(h.sockets[0], "receipt-photo", "A fictional amber star.", "recovered-duplicate")
      await waitFor(() => h.sockets[0].sent.some(value => JSON.parse(value).toolResponse))
      const result = h.sockets[0].sent.flatMap(value => JSON.parse(value).toolResponse?.functionResponses ?? [])
      expect(result[0]).toMatchObject({response: {ok: true, durable: true}, scheduling: "SILENT"})
      expect(h.requests.filter(request => request.url.endsWith("/snapshot/replay"))).toHaveLength(1)
      expect(h.photoCaptions).toHaveLength(1)
      expect(h.errors).toEqual([])
      await h.controller.stop()
    },
  )

  test.each([false, true])("a cold duplicate tool call checks its receipt before saving (conflict=%s)", async conflict => {
    const h = harness({storage: new FakeStorage(), replayBodies: [{filing: {
      caption: "A fictional amber star.", caption_event_id: "old-sitting:photo:receipt-photo", status: "complete",
    }}]})
    await start(h)
    saveCaption(h.sockets[0], "receipt-photo", conflict ? "A different fictional scene." : "A fictional amber star.")
    await waitFor(() => h.sockets[0].sent.some(value => JSON.parse(value).toolResponse))
    const result = h.sockets[0].sent.flatMap(value => JSON.parse(value).toolResponse?.functionResponses ?? [])[0]
    expect(result.response).toEqual(conflict ? {ok: false, durable: false, status: "conflict"} : {ok: true, durable: true})
    expect(h.requests.filter(request => request.url.endsWith("/snapshot/replay"))).toHaveLength(1)
    expect(h.requests.some(request => /\/(snapshot|finalize|append)$/.test(request.url))).toBe(false)
    expect(h.sockets[0].sent.some(value => JSON.parse(value).realtimeInput)).toBe(false)
    await h.controller.stop()
  })

  test.each([503, 401, 403, 409])("receipt lookup failure %i is not an invalid photo", async status => {
    const h = harness({storage: new FakeStorage(), replayStatuses: [status]})
    await start(h)
    saveCaption(h.sockets[0], "receipt-photo", "A fictional amber star.")
    const results = () => h.sockets[0].sent.flatMap(value => JSON.parse(value).toolResponse?.functionResponses ?? [])
    await waitFor(() => results().length > 0 || h.errors.length > 0)
    if (status === 503) {
      expect(results()[0]).toMatchObject({response: {ok: false, status: "unavailable"}, scheduling: "SILENT"})
      expect(h.errors).toEqual([])
    } else {
      expect(results()).toEqual([])
      expect(h.errors).toEqual([`OpenAlma photo filing lookup failed (${status})`])
    }
    expect(h.requests.filter(request => request.url.endsWith("/snapshot/replay"))).toHaveLength(1)
    expect(h.requests.some(request => /\/(snapshot|finalize|append)$/.test(request.url))).toBe(false)
    await h.controller.stop()
  })

  test("saves internal perception silently and requests optional spoken description separately", async () => {
    for (const speakDescription of [false, true]) {
      const h = harness({storage: new FakeStorage()})
      await start(h)
      await h.controller.sendImage({
        imageId: `image-${speakDescription}`,
        mimeType: "image/png",
        data: "AQID",
        speakDescription,
      })
      expect(h.sockets[0].sent.some(value => textTurn(JSON.parse(value)))).toBe(false)
      saveCaption(h.sockets[0], `image-${speakDescription}`, "A fictional blue square.")
      h.sockets[0].message({serverContent: {turnComplete: true}})
      await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot/finalize")))
      await waitFor(() => h.sockets[0].sent.some(value => JSON.parse(value).toolResponse))
      expect(h.audio).toEqual([])
      expect(h.sockets[0].sent.filter(value => textTurn(JSON.parse(value)))).toHaveLength(speakDescription ? 1 : 0)
      if (speakDescription) h.sockets[0].message({serverContent: {
        modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]},
        outputTranscription: {text: "Here is my spoken description."}, turnComplete: true,
      }})
      expect(h.audio).toEqual(speakDescription ? ["AAAAAA=="] : [])
      await h.controller.stop()
    }
  })

  test.each([false, true])("an uncached receipt for A leaves pending photo B untouched (conflict=%s)", async conflict => {
    const storage = new FakeStorage()
    const history: NonNullable<Parameters<typeof harness>[0]>["history"] = []
    const h = harness({storage, history, replayBodies: [{filing: {
      caption: "A fictional amber star.", caption_event_id: "old-sitting:photo:photo-a", status: "complete",
    }}]})
    await start(h)
    await h.controller.sendImage({imageId: "photo-b", mimeType: "image/png", data: "BAUG"})
    await waitFor(() => history.some(event => event.event_kind === "image"))
    await new Promise(resolve => setTimeout(resolve, 0))
    const pendingB = JSON.parse(storage.values.get(JOURNAL_KEY)!).pendingImage
    saveCaption(h.sockets[0], "photo-a", conflict ? "A different fictional scene." : "A fictional amber star.", "duplicate-a")
    const results = () => h.sockets[0].sent.flatMap(value => JSON.parse(value).toolResponse?.functionResponses ?? [])
    await waitFor(() => results().some(result => result.id === "duplicate-a"))
    expect(results().find(result => result.id === "duplicate-a").response)
      .toEqual(conflict ? {ok: false, durable: false, status: "conflict"} : {ok: true, durable: true})
    expect(h.requests.filter(request => request.url.endsWith("/snapshot/replay")).map(request => request.body))
      .toEqual([{user_id: CONFIG.userId, soul_id: CONFIG.soulId, image_id: "photo-a"}])
    expect(JSON.parse(storage.values.get(JOURNAL_KEY)!).pendingImage).toEqual(pendingB)
    expect(history.filter(event => event.event_kind === "photo_caption")).toEqual([])
    expect(h.requests.some(request => request.url.endsWith("/snapshot/finalize"))).toBe(false)
    expect(h.sockets[0].sent.filter(value => photoInput(JSON.parse(value)))).toHaveLength(1)
    saveCaption(h.sockets[0], "photo-b", "A fictional blue triangle.", "caption-b")
    await waitFor(() => results().some(result => result.id === "caption-b"))
    expect(history.filter(event => event.event_kind === "photo_caption").map(event => [event.media_ref, event.content]))
      .toEqual([["mentra_media/test-phone/photo-b.png", "A fictional blue triangle."]])
    expect(h.requests.filter(request => request.url.endsWith("/snapshot/finalize")).map(request => request.body.image_id))
      .toEqual(["photo-b"])
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("durable caption handoff during the paced Continuous flush completes without a stale owner access", async () => {
    const storage = new FakeStorage()
    const h = harness({storage, photoDrainTimeoutMs: 2_500})
    await start(h)
    h.controller.sendAudio("AAAA")
    await h.controller.sendImage({imageId: "midflush-photo", mimeType: "image/png", data: "AQID"})
    const audioFrames = () => h.sockets[0].sent.filter(value => JSON.parse(value).realtimeInput?.audio)
    const before = audioFrames().length
    const stopping = h.controller.stop(true)
    await waitFor(() => audioFrames().length > before)
    saveCaption(h.sockets[0], "midflush-photo", "A fictional green notebook.")
    await waitFor(() => h.sockets[0].sent.some(value => JSON.parse(value).toolResponse))
    expect(storage.values.get(JOURNAL_KEY)).toBe("")
    expect(h.requests.some(request => request.url.endsWith("/end"))).toBe(false)
    await stopping
    expect(audioFrames()).toHaveLength(before + 18)
    expect(h.sockets[0].sent.filter(value => JSON.parse(value).realtimeInput?.audioStreamEnd)).toHaveLength(1)
    expect(h.requests.filter(request => request.url.endsWith("/snapshot/finalize"))).toHaveLength(1)
    expect(h.photoRetryChanges).not.toContain(true)
    expect(h.audio).toEqual([])
    expect(h.errors).toEqual([])
    expect(storage.values.get(JOURNAL_KEY)).toBe("")
  })

  test("Stop stays muted while timeout recovery is blocked on local storage", async () => {
    const storage = new FakeStorage()
    let finishReplay!: () => void
    const h = harness({storage, photoDrainTimeoutMs: 5,
      replayGates: [new Promise<void>(resolve => { finishReplay = resolve })]})
    await start(h)
    h.controller.muteForStop()
    h.sockets[0].message({serverContent: {modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}}})
    await h.controller.sendImage({imageId: "timeout-photo", mimeType: "image/png", data: "AQID"})
    h.sockets[0].message({serverContent: {turnComplete: true}})
    await waitFor(() => h.requests.some(request => request.url.endsWith("/snapshot/replay")))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.audio).toEqual([])
    let release!: () => void
    storage.setGate = new Promise<void>(resolve => { release = resolve })
    const before = storage.setCalls
    const stopping = h.controller.stop(true)
    try {
      await waitFor(() => storage.setCalls > before && h.photoRetryChanges.at(-1) === true)
      expect(h.requests.some(request => request.url.endsWith("/end"))).toBe(false)
      finishReplay()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(h.sockets[0].sent.some(value => photoInput(JSON.parse(value)))).toBe(false)
      expect(h.photoRetryChanges.at(-1)).toBe(true)
      h.sockets[0].message({serverContent: {
        modelTurn: {parts: [{inlineData: {data: "AQEBAQ=="}}]},
        outputTranscription: {text: "Unheard timeout cleanup output."},
      }})
      expect(h.audio).toEqual([])
      expect(h.errors).toEqual([])
    } finally {
      finishReplay()
      storage.setGate = null
      release()
      await stopping
    }
    expect(h.requests.filter(request => request.url.endsWith("/transcripts/append"))
      .flatMap(request => request.body.events).some(event => event.content === "Unheard timeout cleanup output.")).toBe(false)
    expect(JSON.parse(storage.values.get(JOURNAL_KEY)!).pendingImage.imageId).toBe("timeout-photo")
  })

  test("a silent photo does not mute the answer already in progress", async () => {
    const h = harness({storage: new FakeStorage()})
    await start(h)
    h.sockets[0].message({serverContent: {
      inputTranscription: {text: "Current question."},
      outputTranscription: {text: "Current answer."}, modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]},
    }})
    await h.controller.sendImage({imageId: "image-queued", mimeType: "image/png", data: "AQID"})
    h.sockets[0].message({serverContent: {
      modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]},
      outputTranscription: {text: "Current answer finished."},
      turnComplete: true,
    }})
    await waitFor(() => h.sockets[0].sent.some(value => photoInput(JSON.parse(value))))
    saveCaption(h.sockets[0], "image-queued", "A fictional blue square.")
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot/finalize")))

    expect(h.audio).toEqual(["AAAAAA==", "AAAAAA=="])
    await h.controller.stop()
  })

  test.each([413, 422, 503])("a rejected snapshot (%i) keeps the original upload retry available", async status => {
    const options = {storage: new FakeStorage(), snapshotStatus: status}
    const h = harness(options)
    await start(h)
    await expect(h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})).rejects.toThrow(
      `OpenAlma snapshot failed (${status})`,
    )
    expect(h.sockets[0].sent).toHaveLength(1)
    expect(h.photoRetryChanges.at(-1)).not.toBe(true)
    if (status < 500) expect(options.storage.values.get(JOURNAL_KEY)).toBe("")
    else expect(JSON.parse(options.storage.values.get(JOURNAL_KEY)!).pendingImage.imageId).toBe("image-1")
    options.snapshotStatus = 200
    await h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    expect(h.requests.filter(request => request.url.endsWith("/snapshot"))).toHaveLength(2)
    expect(h.requests.some(request => request.url.endsWith("/snapshot/replay"))).toBe(false)
    expect(h.sockets[0].sent).toHaveLength(2)
    expect(h.sockets[0].sent.map(value => JSON.parse(value)).filter(photoInput)).toEqual([photoTurn("image-1")])
    await h.controller.stop()
  })

  test("an uncertain upload keeps its identity through a failed resend", async () => {
    const storage = new FakeStorage()
    const options = {storage, snapshotThrows: true, snapshotStatus: 200}
    const h = harness(options)
    await start(h)
    const image = {imageId: "uncertain-photo", mimeType: "image/png" as const, data: "AQID"}
    await expect(h.controller.sendImage(image)).rejects.toThrow("acknowledgment lost")
    expect(h.photoRetryChanges.at(-1)).not.toBe(true)
    const uncertain = options.storage.values.get(JOURNAL_KEY)
    await expect(h.controller.sendImage({...image, imageId: "different-photo"}))
      .rejects.toThrow("Another photo is still pending")
    expect(options.storage.values.get(JOURNAL_KEY)).toBe(uncertain)
    expect(h.requests.filter(request => request.url.endsWith("/snapshot"))).toHaveLength(1)
    options.snapshotThrows = false
    options.snapshotStatus = 503
    await expect(h.controller.sendImage(image)).rejects.toThrow("snapshot failed (503)")
    expect(JSON.parse(storage.values.get(JOURNAL_KEY)!).pendingImage.imageId).toBe(image.imageId)
    const unknown = storage.values.get(JOURNAL_KEY)
    await expect(h.controller.sendImage({...image, imageId: "different-photo"}))
      .rejects.toThrow("Another photo is still pending")
    expect(storage.values.get(JOURNAL_KEY)).toBe(unknown)
    expect(h.requests.filter(request => request.url.endsWith("/snapshot"))).toHaveLength(2)
    options.snapshotStatus = 200
    await h.controller.sendImage(image)
    expect(h.sockets[0].sent.filter(value => photoInput(JSON.parse(value)))).toHaveLength(1)
    expect(h.requests.some(request => request.url.endsWith("/snapshot/replay"))).toBe(false)
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
    expect(h.sockets[0].sent.filter((value) => photoInput(JSON.parse(value)))).toHaveLength(1)
    await h.controller.stop()
  })

  test("requires explicit Discard before a retake replaces an accepted provider-send failure", async () => {
    const storage = new FakeStorage()
    const h = harness({storage})
    await start(h)
    h.sockets[0].failAtSendCount = 1
    await expect(h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"}))
      .rejects.toThrow("Gemini image send failed")
    expect(h.photoRetryChanges.at(-1)).toBe(true)
    const retained = storage.values.get(JOURNAL_KEY)

    h.sockets[0].failAtSendCount = null
    await expect(h.controller.sendImage({imageId: "image-2", mimeType: "image/png", data: "AQID"}))
      .rejects.toThrow("Another photo is still pending")
    expect(storage.values.get(JOURNAL_KEY)).toBe(retained)
    expect(h.requests.filter(request => request.url.endsWith("/snapshot"))).toHaveLength(1)
    expect(h.photoRetryChanges.at(-1)).toBe(true)
    await h.controller.discardImage()
    expect(storage.values.get(JOURNAL_KEY)).toBe("")
    await h.controller.sendImage({imageId: "image-2", mimeType: "image/png", data: "AQID"})

    expect(h.sockets[0].sent.filter((value) => photoInput(JSON.parse(value)))).toHaveLength(1)
    await h.controller.stop()
  })

  test("a retained unsent retry must be explicitly discarded before replacement clears its actions", async () => {
    const storage = new FakeStorage()
    storage.values.set("openalma:gemini-session-v1", JSON.stringify({
      version: 1,
      scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
      resumption: null,
      pendingTranscripts: [],
      pendingImage: {
        imageId: "image-1",
        mediaRef: "mentra_media/test-phone/image-1.png",
        providerSent: false,
        captureAfterCurrent: false,
        generation: 1,
        sessionId: "old-sitting",
      },
    }))
    const h = harness({storage, replayStatuses: [503]})
    await start(h)
    await waitFor(() => h.photoRetryChanges.at(-1) === true)

    const retained = storage.values.get(JOURNAL_KEY)
    await expect(h.controller.sendImage({imageId: "image-2", mimeType: "image/png", data: "AQID"}))
      .rejects.toThrow("Another photo is still pending")
    expect(storage.values.get(JOURNAL_KEY)).toBe(retained)
    expect(h.photoRetryChanges.at(-1)).toBe(true)
    expect(h.requests.some(request => request.url.endsWith("/snapshot"))).toBe(false)
    await h.controller.discardImage()
    expect(storage.values.get(JOURNAL_KEY)).toBe("")
    expect(h.photoRetryChanges.at(-1)).toBe(false)
    await h.controller.sendImage({imageId: "image-2", mimeType: "image/png", data: "AQID"})

    expect(h.photoRetryChanges.at(-1)).toBe(false)
    await h.controller.stop()
  })

  test("discard clears stale projected actions without a journal row", async () => {
    const h = harness({storage: new FakeStorage()})
    await start(h)

    await h.controller.discardImage()

    expect(h.photoRetryChanges.at(-1)).toBe(false)
    expect(h.persistenceErrors.at(-1)).toBeNull()
    await h.controller.stop()
  })

  test("Stop during snapshot or replay never sends stale images or changes replacement recovery", async () => {
    let release!: () => void
    const snapshotGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const uploadStorage = new FakeStorage()
    const h = harness({storage: uploadStorage, snapshotGate})
    await start(h)
    const sending = h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot")))
    expect(h.photoRetryChanges.at(-1)).not.toBe(true)
    await h.controller.stop()
    expect(JSON.parse(uploadStorage.values.get(JOURNAL_KEY)!).pendingImage).toEqual(expect.objectContaining({
      imageId: "image-1", providerSent: false,
    }))
    expect(h.persistenceErrors.at(-1)).toContain("Photo may have been saved")
    release()
    await expect(sending).rejects.toThrow("Photo send cancelled")
    expect(h.sockets[0].sent.filter((value) => photoInput(JSON.parse(value)))).toHaveLength(0)

    for (const [status, body] of [
      [404, null],
      [503, null],
      [200, {}],
      [200, {mime_type: "image/png", data: "AQID"}],
    ] as const) {
      const storage = new FakeStorage()
      const seed = harness({storage})
      await start(seed)
      await seed.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
      await seed.controller.stop(true)

      let finishReplay!: () => void
      const replayGate = new Promise<void>((resolve) => { finishReplay = resolve })
      const response = Response.json(body, {status})
      let readingBody = false
      if (status === 200) {
        spyOn(response, "json").mockImplementation(async () => {
          readingBody = true
          await replayGate
          return body
        })
      }
      const old = harness({storage, startSequence: 42, replayResponses: [response], replayGates: status === 200 ? [] : [replayGate]})
      await start(old)
      const retrying = old.controller.retryImage()
      await waitFor(() => status === 200 ? readingBody :
        old.requests.some((request) => request.url.endsWith("/snapshot/replay")))
      await old.controller.stop()

      const replacement = harness({storage, startSequence: 42, appendStatuses: Array(100).fill(503)})
      await start(replacement)
      completeTurn(replacement, "A fictional replacement question.", "A fictional replacement answer.")
      await waitFor(() => replacement.requests.some((request) => request.url.endsWith("/transcripts/append")))
      const journal = storage.values.get("openalma:gemini-session-v1")!
      expect(JSON.parse(journal).pendingImage.imageId).toBe("image-1")
      expect(JSON.parse(journal).pendingTranscripts).toHaveLength(2)
      const callbacks = [old.photoRetryChanges.length, old.persistenceErrors.length, old.errors.length]

      finishReplay()
      await retrying

      expect(storage.values.get("openalma:gemini-session-v1")).toBe(journal)
      expect([old.photoRetryChanges.length, old.persistenceErrors.length, old.errors.length]).toEqual(callbacks)
      expect(old.errors).toEqual([])
      expect(old.sockets[0].sent.filter((value) => photoInput(JSON.parse(value)))).toHaveLength(0)
      await replacement.controller.stop()
    }
  })

  test("Stop during snapshot body read cannot alter replacement recovery", async () => {
    const storage = new FakeStorage()
    let finishBody!: () => void
    const bodyGate = new Promise<void>((resolve) => { finishBody = resolve })
    const response = Response.json({ok: true, media_ref: "mentra_media/test-phone/image-1.png"})
    let readingBody = false
    spyOn(response, "json").mockImplementation(async () => {
      readingBody = true
      await bodyGate
      return {ok: true, media_ref: "mentra_media/test-phone/image-1.png"}
    })
    const old = harness({storage, snapshotResponse: response})
    await start(old)
    const sending = old.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    await waitFor(() => readingBody)
    await old.controller.stop()

    const replacement = harness({storage, appendStatuses: Array(100).fill(503), startBody: {
      session_id: "replacement-sitting", next_transcript_sequence: 41, ephemeral_token: "ephemeral/test",
      websocket: {api_version: "v1beta", method: "BidiGenerateContentConstrained",
        input_audio_rate_hz: 16000, output_audio_rate_hz: 24000},
      lease_seconds: 90, session_warning_seconds: 0,
    }})
    await start(replacement)
    const retained = storage.values.get(JOURNAL_KEY)
    await expect(replacement.controller.sendImage({imageId: "replacement-photo", mimeType: "image/png", data: "AQID"}))
      .rejects.toThrow("Another photo is still pending")
    expect(storage.values.get(JOURNAL_KEY)).toBe(retained)
    expect(replacement.requests.some(request => request.url.endsWith("/snapshot"))).toBe(false)
    await replacement.controller.discardImage()
    await replacement.controller.sendImage({imageId: "replacement-photo", mimeType: "image/png", data: "AQID"})
    completeTurn(replacement, "A fictional replacement question.", "A fictional replacement caption.")
    await waitFor(() => replacement.persistenceErrors.at(-1) === "Transcript sync failed; retrying")
    const journal = storage.values.get("openalma:gemini-session-v1")!
    expect(JSON.parse(journal).pendingImage.imageId).toBe("replacement-photo")
    expect(JSON.parse(journal).pendingTranscripts).toHaveLength(3)
    const callbacks = [old.photoRetryChanges.length, old.persistenceErrors.length, old.errors.length]
    const replacementCallbacks = [replacement.photoRetryChanges.length, replacement.persistenceErrors.length,
      replacement.errors.length]
    const requests = old.requests.length

    finishBody()
    await expect(sending).rejects.toThrow("Photo send cancelled")

    expect(storage.values.get("openalma:gemini-session-v1")).toBe(journal)
    expect([old.photoRetryChanges.length, old.persistenceErrors.length, old.errors.length]).toEqual(callbacks)
    expect([replacement.photoRetryChanges.length, replacement.persistenceErrors.length,
      replacement.errors.length]).toEqual(replacementCallbacks)
    expect(old.requests).toHaveLength(requests)
    expect(old.sockets[0].sent.filter((value) => photoInput(JSON.parse(value)))).toHaveLength(0)
    await replacement.controller.stop()
  })

  test("snapshot finishing after reconnect sends the photo on the replacement", async () => {
    let release!: () => void
    const snapshotGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness({storage: new FakeStorage(), snapshotGate})
    await start(h)
    h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
    const sending = h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot")))
    await expect(h.controller.sendImage({imageId: "overlapping-photo", mimeType: "image/png", data: "BAUG"}))
      .rejects.toThrow("Wait for the current photo upload to finish")
    expect(h.requests.filter(request => request.url.endsWith("/snapshot"))).toHaveLength(1)
    h.sockets[0].close()
    await waitFor(() => h.sockets.length === 2)
    h.sockets[1].open()
    h.sockets[1].message({setupComplete: {}})
    release()
    await sending

    expect(h.sockets[1].sent.filter((value) => photoInput(JSON.parse(value)))).toHaveLength(1)
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("snapshot finishing after its pending photo was discarded does not resurrect it", async () => {
    let release!: () => void
    const snapshotGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const storage = new FakeStorage()
    storage.values.set("openalma:gemini-session-v1", JSON.stringify({
      version: 1,
      scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
      resumption: null,
      pendingTranscripts: [],
      pendingImage: {
        imageId: "image-1",
        mediaRef: "mentra_media/test-phone/image-1.png",
        providerSent: false,
        captureAfterCurrent: false,
        generation: 1,
        sessionId: "old-sitting",
      },
    }))
    const h = harness({storage, snapshotGate, replayStatuses: [503]})
    await start(h)
    await waitFor(() => h.photoRetryChanges.at(-1) === true)
    const sending = h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    await waitFor(() => h.requests.filter((request) => request.url.endsWith("/snapshot")).length === 1)
    await h.controller.discardImage()
    release()
    await expect(sending).rejects.toThrow("Photo send cancelled")

    expect(h.sockets[0].sent.filter((value) => photoInput(JSON.parse(value)))).toHaveLength(0)
    await h.controller.stop()
  })

  test("a new photo cannot replace an accepted photo during automatic replay", async () => {
    let release!: () => void
    const replayGate = new Promise<void>((resolve) => { release = resolve })
    const storage = new FakeStorage()
    const h = harness({storage, replayGates: [replayGate]})
    try {
      await start(h)
      await h.controller.sendImage({imageId: "original-photo", mimeType: "image/png", data: "AQID"})
      h.sockets[0].message({serverContent: {interrupted: true, turnComplete: true}})
      completeTurn(h)
      await waitFor(() => h.requests.some(request => request.url.endsWith("/snapshot/replay")))
      await expect(h.controller.sendImage({imageId: "new-photo", mimeType: "image/jpeg", data: "AQID"}))
        .rejects.toThrow("Another photo is still pending")
      expect(h.requests.filter(request => request.url.endsWith("/snapshot"))).toHaveLength(1)
      expect(JSON.parse(storage.values.get(JOURNAL_KEY)!).pendingImage.imageId).toBe("original-photo")
    } finally {
      release()
      await h.controller.stop()
    }
  })

  test("reconnect during journal write sends one photo", async () => {
    let release!: () => void
    const storage = new FakeStorage()
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness({storage})
    await start(h)
    const before = storage.setCalls
    storage.setGate = gate
    h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
    const sending = h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    await waitFor(() => storage.setCalls > before)
    h.sockets[0].close()
    await waitFor(() => h.sockets.length === 2)
    h.sockets[1].open()
    h.sockets[1].message({setupComplete: {}})
    release()
    await sending
    await waitFor(() => h.sockets[1].sent.some((value) => photoInput(JSON.parse(value))))

    expect(h.sockets[1].sent.filter((value) => photoInput(JSON.parse(value)))).toHaveLength(1)
    await h.controller.stop()
  })

  test("acknowledges durable photo filing before the caption timeline append", async () => {
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
    saveCaption(h.sockets[0], "image-1", "A fictional blue square.")
    await waitFor(() => h.requests.filter((request) => request.url.endsWith("/transcripts/append")).length === 2)
    await waitFor(() => h.sockets[0].sent.some(value => JSON.parse(value).toolResponse))
    expect(h.requests.some((request) => request.url.endsWith("/snapshot/finalize"))).toBe(true)
    releaseCaption()
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot/finalize")))
    await h.controller.stop()
  })

  test("keeps the spoken answer separate from the explicit photo perception", async () => {
    const h = harness({storage: new FakeStorage()})
    await start(h)
    await h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    h.sockets[0].message({serverContent: {
      modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]},
      inputTranscription: {text: "What do you see?"},
      outputTranscription: {text: "I see a fictional blue square."},
      turnComplete: true,
    }})
    expect(h.requests.some(request => request.url.endsWith("/snapshot/finalize"))).toBe(false)
    saveCaption(h.sockets[0], "image-1", "A blue square beside a fictional notebook.")
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot/finalize")))

    expect(h.requests.find((request) => request.url.endsWith("/snapshot/finalize"))?.body.caption).toBe(
      "A blue square beside a fictional notebook.",
    )
    expect(h.audio).toEqual(["AAAAAA=="])
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("failed finalization exposes a working Retry", async () => {
    const storage = new FakeStorage()
    const h = harness({storage, finalizeStatuses: Array(100).fill(503)})
    await start(h)
    await h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    saveCaption(h.sockets[0], "image-1", "A fictional blue square.")
    await waitFor(() => h.photoRetryChanges.at(-1) === true)
    h.finalizeStatuses.splice(0, h.finalizeStatuses.length, 200)
    const attemptsBeforeRetry = h.requests.filter((request) => request.url.endsWith("/snapshot/finalize")).length
    saveCaption(h.sockets[0], "image-1", "A fictional blue square.", "duplicate-failed-caption")
    await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "duplicate-failed-caption"))
    expect(functionResponses(h.sockets[0]).find(response => response.id === "duplicate-failed-caption"))
      .toMatchObject({response: {ok: false, status: "failed"}, scheduling: "SILENT"})
    expect(h.requests.filter(request => request.url.endsWith("/snapshot/finalize"))).toHaveLength(attemptsBeforeRetry)
    expect(h.photoRetryChanges.at(-1)).toBe(true)
    expect(JSON.parse(storage.values.get(JOURNAL_KEY)!).pendingImage)
      .toMatchObject({caption: "A fictional blue square.", retryRequested: true})

    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_START"}})
    await h.controller.retryImage()

    expect(h.requests.filter((request) => request.url.endsWith("/snapshot/finalize"))).toHaveLength(
      attemptsBeforeRetry + 1,
    )
    expect(h.photoRetryChanges.at(-1)).toBe(false)
    expect(h.persistenceErrors.at(-1)).toBeNull()
    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_END"}})
    completeTurn(h, "Continue speaking during caption retry.", "The caption retry did not block us.", true)
    await h.controller.stop()
  })

  test("Stop retains a pending photo for explicit recovery after the next Start", async () => {
    const storage = new FakeStorage()
    const old = harness({storage, finalizeStatuses: Array(100).fill(503)})
    await start(old)
    await old.controller.sendImage({imageId: "retained-photo", mimeType: "image/png", data: "AQID"})
    saveCaption(old.sockets[0], "retained-photo", "A fictional paper kite.")
    await waitFor(() => old.photoRetryChanges.at(-1) === true)
    await old.controller.stop()
    expect(JSON.parse(storage.values.get(JOURNAL_KEY)!).pendingImage.caption).toBe("A fictional paper kite.")
    const next = harness({storage, startSequence: 43})
    await start(next)
    expect(next.photoRetryChanges.at(-1)).toBe(true)
    expect(next.requests.some(request => request.url.endsWith("/snapshot/finalize"))).toBe(false)
    await next.controller.discardImage()
    expect(next.photoRetryChanges.at(-1)).toBe(false)
    expect(storage.values.get(JOURNAL_KEY)).toBe("")
    expect(next.errors).toEqual([])
    await next.controller.stop()
  })

  for (const status of [200, 503, 400, "network"] as const) {
    test(`caption-ready Retry finalization after Stop preserves replacement recovery (${status})`, async () => {
      const storage = new FakeStorage()
      const old = harness({storage, finalizeStatuses: [503]})
      await start(old)
      await old.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
      saveCaption(old.sockets[0], "image-1", "A fictional blue square.")
      await waitFor(() => old.photoRetryChanges.at(-1) === true)
      const captionJournal = JSON.parse(storage.values.get("openalma:gemini-session-v1")!)
      expect(captionJournal.pendingImage.caption).toBe("A fictional blue square.")
      expect(captionJournal.pendingImage.captionEventId).toBe("sitting-1:photo:image-1")
      expect(captionJournal.pendingTranscripts).toEqual([])

      let finishFinalize!: () => void
      const finalizeGate = new Promise<void>((resolve, reject) => {
        finishFinalize = status === "network" ? () => reject(new Error("fictional network miss")) : resolve
      })
      old.finalizeGates.push(finalizeGate)
      old.finalizeStatuses.splice(0, old.finalizeStatuses.length, status === "network" ? 200 : status)
      const attempts = old.requests.filter((request) => request.url.endsWith("/snapshot/finalize")).length
      const retrying = old.controller.retryImage()
      await waitFor(() => old.requests.filter((request) => request.url.endsWith("/snapshot/finalize"))
        .length === attempts + 1)
      expect(old.requests.at(-1)!.body.caption_event_id).toBe("sitting-1:photo:image-1")
      await old.controller.stop()

      const replacement = harness({storage, appendStatuses: Array(100).fill(503), startBody: {
        session_id: "replacement-sitting", next_transcript_sequence: 43, ephemeral_token: "ephemeral/test",
        websocket: {api_version: "v1beta", method: "BidiGenerateContentConstrained",
          input_audio_rate_hz: 16000, output_audio_rate_hz: 24000},
        lease_seconds: 90, session_warning_seconds: 0,
      }})
      await start(replacement)
      completeTurn(replacement, "A fictional replacement question.", "A fictional replacement answer.")
      await waitFor(() => replacement.persistenceErrors.at(-1) === "Transcript sync failed; retrying")
      const journal = storage.values.get("openalma:gemini-session-v1")!
      expect(JSON.parse(journal).pendingImage.imageId).toBe("image-1")
      expect(JSON.parse(journal).pendingTranscripts).toHaveLength(2)
      const callbacks = [old.photoRetryChanges.length, old.persistenceErrors.length, old.errors.length]
      const replacementCallbacks = [replacement.photoRetryChanges.length, replacement.persistenceErrors.length,
        replacement.errors.length]
      const requests = old.requests.length

      finishFinalize()
      await retrying

      expect(storage.values.get("openalma:gemini-session-v1")).toBe(journal)
      expect([old.photoRetryChanges.length, old.persistenceErrors.length, old.errors.length]).toEqual(callbacks)
      expect([replacement.photoRetryChanges.length, replacement.persistenceErrors.length,
        replacement.errors.length]).toEqual(replacementCallbacks)
      expect(old.requests).toHaveLength(requests)
      expect(old.errors).toEqual([])
      await replacement.controller.stop()
    })
  }

  test("slow photo filing does not block later dialogue uploads", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {release = resolve})
    const h = harness({storage: new FakeStorage(), finalizeGates: [gate]})
    await start(h)
    await h.controller.sendImage({imageId: "slow-photo", mimeType: "image/png", data: "AQID"})
    saveCaption(h.sockets[0], "slow-photo", "A fictional notebook.")
    await waitFor(() => h.requests.some(request => request.url.endsWith("/snapshot/finalize")))
    completeTurn(h, "Continue the conversation.", "We can continue.")
    await waitFor(() => h.requests.some(request => request.body.events?.some(
      (event: {content: string}) => event.content === "We can continue.",
    )))
    release()
    await h.controller.stop()
    expect(h.errors).toEqual([])
  })

  test("an unconfirmed upload recovers its original media reference without another upload", async () => {
    const storage = new FakeStorage()
    storage.values.set(JOURNAL_KEY, JSON.stringify({version: 1,
      scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
      resumption: null, pendingTranscripts: [], pendingImage: {
        imageId: "upload-race", mediaRef: "", providerSent: false, captureAfterCurrent: false,
        generation: 1, sessionId: "old-sitting", retryRequested: true,
      }}))
    const h = harness({storage, replayBodies: [{mime_type: "image/png", data: "AQID",
      media_ref: "mentra_media/test-phone/upload-race.png"}]})
    await start(h)
    await h.controller.retryImage()
    const journal = JSON.parse(storage.values.get(JOURNAL_KEY)!)
    expect(journal.pendingImage.mediaRef).toBe("mentra_media/test-phone/upload-race.png")
    expect(journal.pendingImage.providerSent).toBe(true)
    expect(h.requests.some(request => request.url.endsWith("/snapshot"))).toBe(false)
    await h.controller.stop()
  })

  test("normal Stop waits for caption finalization and clears photo recovery", async () => {
    const storage = new FakeStorage()
    let finishFinalize!: () => void
    const finalizeGate = new Promise<void>((resolve) => { finishFinalize = resolve })
    const h = harness({storage, finalizeGates: [finalizeGate]})
    await start(h)
    await h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    saveCaption(h.sockets[0], "image-1", "A fictional blue square.")
    let stopped = false
    const stopping = h.controller.stop().then(() => { stopped = true })
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot/finalize")))
    expect(stopped).toBe(false)
    expect(h.requests.some((request) => request.url.endsWith("/end"))).toBe(false)
    expect(JSON.parse(storage.values.get("openalma:gemini-session-v1")!).pendingImage.caption)
      .toBe("A fictional blue square.")

    finishFinalize()
    await stopping

    expect(storage.values.get("openalma:gemini-session-v1")).toBe("")
    expect(h.photoRetryChanges.at(-1)).toBe(false)
    expect(h.persistenceErrors.at(-1)).toBeNull()
    expect(h.errors).toEqual([])
    expect(h.requests.filter((request) => request.url.endsWith("/snapshot/finalize"))).toHaveLength(1)
    expect(h.requests.some((request) => request.url.endsWith("/end"))).toBe(true)
  })

  test("non-graceful Stop retains the uncaptured photo without a fake transcript failure", async () => {
    const h = harness({storage: new FakeStorage()})
    await start(h)
    await h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    await h.controller.stop()

    expect(h.errors).toEqual([])
    expect(h.requests.some(request => request.url.endsWith("/snapshot/finalize"))).toBe(false)
    expect(h.photoRetryChanges.at(-1)).not.toBe(true)
    expect(h.persistenceErrors).not.toContain("Transcript sync failed; pending turns remain saved on this device")
  })

  test("keeps refused or malformed photo replay available for explicit recovery", async () => {
    for (const [status, body, message] of [
      [404, undefined, "OpenAlma snapshot replay failed (404)"],
      [200, {}, "OpenAlma snapshot replay returned invalid image data"],
    ] as const) {
      const storage = new FakeStorage()
      storage.values.set("openalma:gemini-session-v1", JSON.stringify({
        version: 1,
        scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
        resumption: null,
        pendingTranscripts: [],
        pendingImage: {
          imageId: "missing-image",
          mediaRef: "mentra_media/test-phone/missing-image.png",
          providerSent: false,
          captureAfterCurrent: false,
          generation: 1,
          sessionId: "old-sitting",
          retryRequested: true,
        },
      }))
      const h = harness({storage, replayStatuses: [status], replayBodies: body ? [body] : []})
      await start(h)
      await h.controller.retryImage()
      expect(h.errors).toEqual([])
      expect(h.photoRetryChanges.at(-1)).toBe(true)
      expect(h.persistenceErrors.at(-1)).toBe(PHOTO_RETRY_MESSAGE)
      expect(JSON.parse(storage.values.get(JOURNAL_KEY)!).pendingImage.imageId).toBe("missing-image")
      await h.controller.stop()
    }
  })

  test("keeps a transiently failed replay for an explicit retry", async () => {
    const storage = new FakeStorage()
    storage.values.set("openalma:gemini-session-v1", JSON.stringify({
      version: 1,
      scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
      resumption: null,
      pendingTranscripts: [],
      pendingImage: {
        imageId: "image-1",
        mediaRef: "mentra_media/test-phone/image-1.png",
        providerSent: false,
        captureAfterCurrent: false,
        generation: 1,
        sessionId: "old-sitting",
        retryRequested: true,
      },
    }))
    const h = harness({storage, replayStatuses: [503, 200]})
    await start(h)
    expect(h.requests.some((request) => request.url.endsWith("/snapshot/replay"))).toBe(false)
    await h.controller.retryImage()
    await waitFor(() => h.persistenceErrors.at(-1) === PHOTO_RETRY_MESSAGE)
    expect(h.photoRetryChanges.at(-1)).toBe(true)
    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_START"}})
    await expect(h.controller.retryImage()).rejects.toThrow("Wait for the current reply to finish")
    expect(h.requests.filter(request => request.url.endsWith("/snapshot/replay"))).toHaveLength(1)
    expect(h.photoRetryChanges.at(-1)).toBe(true)
    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_END"}})
    h.sockets[0].message({serverContent: {
      inputTranscription: {text: "A fictional question."},
      outputTranscription: {text: "A fictional complete turn."}, modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}, turnComplete: true,
    }})
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.requests.filter((request) => request.url.endsWith("/snapshot/replay"))).toHaveLength(1)
    expect(h.errors).toEqual([])
    h.sockets[0].readyState = 0
    await expect(h.controller.retryImage()).rejects.toThrow("Wait for Gemini")
    expect(h.photoRetryChanges.at(-1)).toBe(true)
    h.sockets[0].readyState = 1
    const recovered = harness({storage})
    await start(recovered)
    expect(recovered.photoRetryChanges.at(-1)).toBe(true)
    expect(recovered.requests.some((request) => request.url.endsWith("/snapshot/replay"))).toBe(false)
    await recovered.controller.stop()
    h.sockets[0].message({toolCall: {
      functionCalls: [{id: "before-retry", name: "recall_memory", args: {query: "fictional context"}}],
    }})
    await waitFor(() => h.sockets[0].sent.some((value) => JSON.parse(value).toolResponse))
    await h.controller.retryImage()
    await waitFor(() => h.sockets[0].sent.some((value) => photoInput(JSON.parse(value))))
    h.sockets[0].message({serverContent: {
      outputTranscription: {text: "The memory-tool follow-up."}, modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]},
      turnComplete: true,
    }})
    expect(h.requests.some((request) => request.url.endsWith("/snapshot/finalize"))).toBe(false)
    saveCaption(h.sockets[0], "image-1", "A fictional blue square.")
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot/finalize")))

    expect(h.persistenceErrors.at(-1)).toBeNull()
    expect(h.photoRetryChanges.at(-1)).toBe(false)
    expect(h.requests.filter((request) => request.url.endsWith("/snapshot/replay"))).toHaveLength(2)
    expect(h.requests.filter((request) => request.url.endsWith("/transcripts/append"))
      .flatMap((request) => request.body.events)
      .some((event) => event.event_kind === "image")).toBe(true)
    await h.controller.stop()
  })

  test("pause during photo upload or replay retains explicit Retry and Discard", async () => {
    const storage = new FakeStorage()
    let finishUpload!: () => void
    const uploadGate = new Promise<void>(resolve => { finishUpload = resolve })
    const h = harness({storage, snapshotGate: uploadGate})
    await start(h)
    const sending = h.controller.sendImage({imageId: "paused-photo", mimeType: "image/png", data: "AQID"})
    await waitFor(() => h.requests.some(request => request.url.endsWith('/snapshot')))
    h.controller.activityPauseReason = "Paused. Retry in OpenAlma launcher."
    finishUpload()
    await expect(sending).rejects.toThrow("Retry in OpenAlma launcher")
    expect(h.photoRetryChanges.at(-1)).toBe(true)
    await h.controller.stop()
    let finishReplay!: () => void
    const replayGate = new Promise<void>(resolve => { finishReplay = resolve })
    const recovered = harness({storage, replayGates: [replayGate]})
    await start(recovered)
    const retrying = recovered.controller.retryImage()
    await waitFor(() => recovered.requests.some(request => request.url.endsWith('/snapshot/replay')))
    recovered.controller.activityPauseReason = "Paused. Retry in OpenAlma launcher."
    finishReplay()
    await retrying
    expect(recovered.photoRetryChanges.at(-1)).toBe(true)
    recovered.controller.activityPauseReason = null
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(recovered.requests.filter(request => request.url.endsWith('/snapshot/replay'))).toHaveLength(1)
    await recovered.controller.stop()
  })

  test("does not treat later speech as the image turn while finalization retries", async () => {
    const h = harness({storage: new FakeStorage(), finalizeStatuses: Array(10).fill(503)})
    await start(h)
    await h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    saveCaption(h.sockets[0], "image-1", "A fictional blue square.")
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
      outputTranscription: {text: "The older tool answer."}, modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]},
      turnComplete: true,
    }})
    saveCaption(h.sockets[0], "image-1", "The photo shows a fictional blue square.")
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot/finalize")))

    expect(h.requests.find((request) => request.url.endsWith("/snapshot/finalize"))?.body.caption).toBe(
      "The photo shows a fictional blue square.",
    )
    const rows = h.requests.filter(request => request.url.endsWith("/transcripts/append"))
      .flatMap(request => request.body.events)
    expect(rows.map(event => [event.sequence, event.event_kind, event.content])).toEqual([
      [41, "image", "Shared a photo."],
      [42, "transcript", "The older tool answer."],
      [43, "photo_caption", "The photo shows a fictional blue square."],
    ])
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("does not bind an image-turn tool preamble as the caption", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness({storage: new FakeStorage(), recallGate: gate})
    await start(h)
    await h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    h.sockets[0].message({
      serverContent: {
        inputTranscription: {text: "What do you remember about this photo?"},
        outputTranscription: {text: "Let me check memory first."},
        turnComplete: true,
      },
      toolCall: {
        functionCalls: [{id: "image-recall", name: "recall_memory", args: {query: "blue square"}}],
      },
    })
    release()
    await waitFor(() => h.sockets[0].sent.some((value) => JSON.parse(value).toolResponse))
    expect(h.requests.filter(request => request.url.endsWith("/transcripts/append"))
      .flatMap(request => request.body.events).some(event => event.role === "assistant")).toBe(false)
    expect(h.audio).toEqual([])
    expect(h.requests.some(request => request.url.endsWith("/snapshot/finalize"))).toBe(false)
    expect(h.errors).toEqual([])
    saveCaption(h.sockets[0], "image-1", "The photo shows a fictional blue square.")
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot/finalize")))

    expect(h.requests.find((request) => request.url.endsWith("/snapshot/finalize"))?.body.caption).toBe(
      "The photo shows a fictional blue square.",
    )
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("a resumed caption uses recorded delivery while photo replay is still pending", async () => {
    let releaseReplay!: () => void
    const replayGate = new Promise<void>(resolve => {releaseReplay = resolve})
    const storage = new FakeStorage()
    const h = harness({storage, replayGates: [replayGate]})
    try {
      await start(h)
      h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "photo-delivery-handle"}})
      await h.controller.sendImage({imageId: "resumed-photo", mimeType: "image/png", data: "AQID"})
      await waitFor(() => JSON.parse(storage.values.get(JOURNAL_KEY)!).pendingImage?.imageRecorded === true)
      h.sockets[0].close()
      await waitFor(() => h.sockets.length === 2)
      h.sockets[1].open()
      expect(JSON.parse(h.sockets[1].sent[0])).toEqual({setup: {sessionResumption: {handle: "photo-delivery-handle"}}})
      h.sockets[1].message({setupComplete: {}})
      await waitFor(() => h.requests.some(request => request.url.endsWith("/snapshot/replay")))
      await waitFor(() => JSON.parse(storage.values.get(JOURNAL_KEY)!).pendingImage?.providerSent === false)
      saveCaption(h.sockets[1], "resumed-photo", "A fictional green crescent.")
      await waitFor(() => h.sockets[1].sent.some(value => JSON.parse(value).toolResponse?.functionResponses?.some(
        (response: any) => response.response.durable === true)))
      expect(h.sockets[1].sent.some(value => photoInput(JSON.parse(value)))).toBe(false)
      expect(h.requests.filter(request => request.url.endsWith("/snapshot/finalize"))).toHaveLength(1)
      expect(h.requests.find(request => request.url.endsWith("/snapshot/finalize"))?.body.caption_event_id)
        .toBe("sitting-1:photo:resumed-photo")
      releaseReplay()
      await h.controller.stop()
      expect(h.sockets[1].sent.some(value => photoInput(JSON.parse(value)))).toBe(false)
      expect(h.requests.flatMap(request => request.body.events ?? []).filter(row => row.event_kind === "image"))
        .toHaveLength(1)
      expect(h.errors).toEqual([])
    } finally {
      releaseReplay()
      await h.controller.stop()
    }
  })

  test("hydrates an uncaptioned image for same-id retry without duplicating its event", async () => {
    let releaseReplay!: () => void
    const replayGate = new Promise<void>((resolve) => {
      releaseReplay = resolve
    })
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
    const h = harness({storage, replayGates: [replayGate]})
    await start(h)
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot/replay")))
    h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
    h.sockets[0].close()
    await waitFor(() => h.sockets.length === 2)
    h.sockets[1].open()
    h.sockets[1].message({setupComplete: {}})
    releaseReplay()
    await waitFor(() => h.sockets[1].sent.some((value) => photoInput(JSON.parse(value))))
    saveCaption(h.sockets[1], "image-1", "A fictional blue square.")
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot/finalize")))
    const imageEvents = h.requests.filter((request) => request.url.endsWith("/transcripts/append"))
      .flatMap((request) => request.body.events)
      .filter((event) => event.event_kind === "image")

    expect(new Set(imageEvents.map((event) => event.event_id))).toEqual(new Set(["sitting-1:41"]))
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test.each([true, false])("barge-in waits for the voice reply before retrying the photo (combined=%s)", async combined => {
    const storage = new FakeStorage()
    const h = harness({storage})
    await start(h)
    await h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    h.sockets[0].message({serverContent: {
      inputTranscription: {text: "Wait, what is that?"},
      outputTranscription: {text: "It looks like..."},
      interrupted: true,
      ...(combined ? {turnComplete: true} : {}),
    }})
    if (!combined) h.sockets[0].message({serverContent: {turnComplete: true}})
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.sockets[0].sent.filter(value => photoInput(JSON.parse(value)))).toHaveLength(1)
    expect(JSON.parse(storage.values.get(JOURNAL_KEY)!).pendingImage.providerSent).toBe(false)
    expect(h.photoRetryChanges.at(-1)).not.toBe(true)
    expect(h.persistenceErrors).not.toContain(PHOTO_RETRY_MESSAGE)
    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_START"}})
    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_END"}})
    h.sockets[0].message({serverContent: {
      inputTranscription: {text: "I was still speaking."},
      outputTranscription: {text: "The answer to the interruption, not a photo caption."}, modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]},
      turnComplete: true,
    }})
    await waitFor(() => h.sockets[0].sent.filter((value) => photoInput(JSON.parse(value))).length === 2)
    expect(h.requests.some(request => request.url.endsWith("/snapshot/finalize"))).toBe(false)
    saveCaption(h.sockets[0], "image-1", "The photo shows a fictional blue square.")
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot/finalize")))
    expect(h.requests.find(request => request.url.endsWith("/snapshot/finalize"))?.body.caption)
      .toBe("The photo shows a fictional blue square.")
    const rows = h.requests.filter(request => request.url.endsWith("/transcripts/append"))
      .flatMap(request => request.body.events)
    expect(rows.filter(event => event.event_kind === "image")).toHaveLength(1)
    expect(rows.some(event => event.event_kind === "transcript_gap")).toBe(false)
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("native voice activity fences a stored photo before input transcription arrives", async () => {
    const h = harness({storage: new FakeStorage()})
    await start(h)
    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_START"}})
    await h.controller.sendImage({imageId: "native-fenced", mimeType: "image/png", data: "AQID"})
    expect(h.requests.filter(request => request.url.endsWith("/snapshot"))).toHaveLength(1)
    expect(h.sockets[0].sent.some(value => JSON.parse(value).realtimeInput)).toBe(false)
    expect(h.requests.some(request => request.url.endsWith("/transcripts/append"))).toBe(false)
    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_END"}})
    completeTurn(h, "A preceding spoken question.", "A preceding spoken answer.", true)
    await waitFor(() => h.sockets[0].sent.some(value => photoInput(JSON.parse(value))))
    expect(h.requests.filter(request => request.url.endsWith("/snapshot/replay"))).toHaveLength(1)
    expect(h.sockets[0].sent.filter(value => photoInput(JSON.parse(value))).map(value => JSON.parse(value)))
      .toEqual([photoTurn("native-fenced")])
    saveCaption(h.sockets[0], "native-fenced", "A fictional cobalt circle.")
    await waitFor(() => h.requests.some(request => request.url.endsWith("/snapshot/finalize")))
    const rows = h.requests.filter(request => request.url.endsWith("/transcripts/append"))
      .flatMap(request => request.body.events)
    expect(rows.map(event => [event.sequence, event.event_kind, event.content])).toEqual([
      [41, "transcript", "A preceding spoken question."], [42, "transcript", "A preceding spoken answer."],
      [43, "image", "Shared a photo."], [44, "photo_caption", "A fictional cobalt circle."],
    ])
    expect(rows[2].media_ref).toBe("mentra_media/test-phone/native-fenced.png")
    expect(rows[3].media_ref).toBe(rows[2].media_ref)
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test.each(["complete", "interrupted", "stop"])("orders an already-active speech turn before the image on %s", async boundary => {
    const h = harness({storage: new FakeStorage()})
    await start(h)
    h.sockets[0].message({serverContent: {
      inputTranscription: {text: "Current user turn."},
      outputTranscription: {text: "Current answer."}, modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]},
    }})
    await h.controller.sendImage({imageId: "image-1", mimeType: "image/png", data: "AQID"})
    expect(h.sockets[0].sent.filter(value => photoInput(JSON.parse(value)))).toHaveLength(0)
    expect(h.requests.some(request => request.url.endsWith("/transcripts/append"))).toBe(false)
    if (boundary === "stop") await h.controller.stop()
    else h.sockets[0].message({serverContent: {
      ...(boundary === "interrupted" ? {interrupted: true} : {}), turnComplete: true,
    }})
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.requests.some((request) => request.url.endsWith("/snapshot/finalize"))).toBe(false)
    const preceding = h.requests.filter(request => request.url.endsWith("/transcripts/append"))
      .flatMap(request => request.body.events)
    expect(preceding.map(event => [event.sequence, event.event_kind, event.content, event.status])).toEqual([
      [41, "transcript", "Current user turn.", boundary === "stop" ? "interrupted" : "complete"],
      [42, "transcript", "Current answer.", boundary === "complete" ? "complete" : "interrupted"],
      ...(boundary !== "stop" ? [[43, "image", "Shared a photo.", undefined]] : []),
    ])
    if (boundary === "stop") return
    if (boundary === "interrupted") completeTurn(h, "Finish my question.", "Here is the answer.")
    await waitFor(() => h.sockets[0].sent.some(value => photoInput(JSON.parse(value))))

    saveCaption(h.sockets[0], "image-1", "The photo shows a fictional blue square.")
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot/finalize")))
    expect(h.requests.find((request) => request.url.endsWith("/snapshot/finalize"))?.body.caption).toBe(
      "The photo shows a fictional blue square.",
    )
    const rows = h.requests.filter(request => request.url.endsWith("/transcripts/append"))
      .flatMap(request => request.body.events)
    const expectedSequences = boundary === "interrupted" ? [41, 42, 43, 44, 45, 46] : [41, 42, 43, 44]
    expect(rows.map(event => event.sequence)).toEqual(expectedSequences)
    expect(new Set(rows.map(event => event.event_id)).size).toBe(expectedSequences.length)
    expect(h.requests.find(request => request.url.endsWith("/snapshot/finalize"))?.body.caption_event_id)
      .toBe("sitting-1:photo:image-1")
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("refreshes the photo fence when speech completes during journal preparation", async () => {
    let release!: () => void
    const storage = new FakeStorage()
    const h = harness({storage})
    await start(h)
    h.sockets[0].message({serverContent: {
      inputTranscription: {text: "Current user turn."}, outputTranscription: {text: "Current answer."}, modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]},
    }})
    const before = storage.setCalls
    storage.setGate = new Promise<void>(resolve => {release = resolve})
    const sending = h.controller.sendImage({imageId: "journal-photo", mimeType: "image/png", data: "AQID"})
    await waitFor(() => storage.setCalls > before)
    expect(h.sockets[0].sent.some(value => photoInput(JSON.parse(value)))).toBe(false)
    h.sockets[0].message({serverContent: {turnComplete: true}})
    release()
    await sending
    saveCaption(h.sockets[0], "journal-photo", "The photo shows a fictional blue square.")
    await waitFor(() => h.requests.some(request => request.url.endsWith("/snapshot/finalize")))
    const rows = h.requests.filter(request => request.url.endsWith("/transcripts/append"))
      .flatMap(request => request.body.events)
    expect(rows.map(event => [event.sequence, event.event_kind])).toEqual([
      [41, "transcript"], [42, "transcript"], [43, "image"], [44, "photo_caption"],
    ])
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test.each(["empty", "input", "output", "empty-interrupted"])("preserves honest photo delivery and gaps across a preceding %s boundary", async boundary => {
    const storage = new FakeStorage()
    const h = harness({storage})
    await start(h)
    h.sockets[0].message({serverContent: {
      inputTranscription: {text: boundary === "input" ? "Partial question." : ""},
      outputTranscription: {text: boundary === "output" ? "Partial answer." : ""},
      ...(["input", "output"].includes(boundary) ? {modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}} : {}),
    }})
    await h.controller.sendImage({imageId: "gap-photo", mimeType: "image/png", data: "AQID"})
    h.sockets[0].message({serverContent: {
      ...(boundary === "empty-interrupted" ? {interrupted: true} : {}), turnComplete: true,
    }})
    if (boundary !== "empty-interrupted") {
      await waitFor(() => h.requests.some(request => request.url.endsWith("/transcripts/append")))
    }
    const rows = h.requests.filter(request => request.url.endsWith("/transcripts/append"))
      .flatMap(request => request.body.events)
    expect(rows.map(event => event.sequence)).toEqual(boundary === "empty-interrupted" ? [] : boundary === "empty" ? [41] : [41, 42])
    expect(rows.filter(event => event.event_kind === "image")).toHaveLength(["empty", "output"].includes(boundary) ? 1 : 0)
    expect(rows.some(event => event.event_kind === "photo_caption")).toBe(false)
    expect(h.sockets[0].sent.some(value => photoInput(JSON.parse(value)))).toBe(["empty", "output"].includes(boundary))
    if (boundary !== "input") {
      expect(rows.some(event => event.event_kind === "transcript_gap")).toBe(false)
    }
    expect(JSON.parse(storage.values.get(JOURNAL_KEY)!).pendingImage).toEqual(expect.objectContaining({
      imageId: "gap-photo", mediaRef: "mentra_media/test-phone/gap-photo.png", providerSent: ["empty", "output"].includes(boundary),
    }))
    expect(h.requests.some(request => request.url.endsWith("/snapshot/finalize"))).toBe(false)
    expect(h.errors).toEqual(boundary === "input" ? ["Gemini completed audible speech without its transcription"] : [])
    await h.controller.stop()
  })

  test("defers a recovered photo marker during speech but files before timeline ACK", async () => {
    let releaseReplay!: () => void
    let releaseAppend!: () => void
    const replayGate = new Promise<void>(resolve => {releaseReplay = resolve})
    const appendGate = new Promise<void>(resolve => {releaseAppend = resolve})
    const storage = new FakeStorage()
    storage.values.set(JOURNAL_KEY, JSON.stringify({
      version: 1,
      scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
      resumption: null, pendingTranscripts: [],
      pendingImage: {imageId: "recovered-photo", mediaRef: "mentra_media/test-phone/recovered-photo.png",
        providerSent: false, captureAfterCurrent: false, generation: 1, sessionId: "old-sitting"},
    }))
    const h = harness({storage, replayGates: [replayGate], appendGates: [appendGate]})
    await start(h)
    await waitFor(() => h.requests.some(request => request.url.endsWith("/snapshot/replay")))
    h.sockets[0].message({serverContent: {
      inputTranscription: {text: "Current user turn."}, outputTranscription: {text: "Current answer."}, modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]},
    }})
    releaseReplay()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.sockets[0].sent.filter(value => photoInput(JSON.parse(value)))).toHaveLength(0)
    expect(h.requests.some(request => request.url.endsWith("/transcripts/append"))).toBe(false)
    h.sockets[0].message({serverContent: {turnComplete: true}})
    await waitFor(() => h.sockets[0].sent.some(value => photoInput(JSON.parse(value))))
    saveCaption(h.sockets[0], "recovered-photo", "The photo shows a fictional blue square.")
    await waitFor(() => h.requests.some(request => request.url.endsWith("/transcripts/append")))
    await waitFor(() => h.requests.some(request => request.url.endsWith("/snapshot/finalize")))
    releaseAppend()
    await waitFor(() => h.requests.some(request => request.body.events?.some(
      (event: any) => event.event_kind === "photo_caption")))
    const rows = h.requests.filter(request => request.url.endsWith("/transcripts/append"))
      .flatMap(request => request.body.events)
    expect(rows.map(event => [event.sequence, event.content])).toEqual([
      [41, "Current user turn."], [42, "Current answer."], [43, "Shared a photo."],
      [44, "The photo shows a fictional blue square."],
    ])
    expect(h.requests.find(request => request.url.endsWith("/snapshot/finalize"))?.body.caption_event_id).toBe("sitting-1:photo:recovered-photo")
    expect(h.errors).toEqual([])
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
      authorization: null,
    })
    h.controller.sendAudio("AAAA", "glasses")
    expect(JSON.parse(h.sockets[0].sent[1])).toEqual({
      realtimeInput: {audio: {data: "AAAA", mimeType: "audio/pcm;rate=16000"}},
    })
    await h.controller.stop()
    expect(h.requests.filter((request) => request.url.endsWith("/sitting-1/end"))).toHaveLength(1)
    expect(h.requests.every((request) => request.authorization === null)).toBe(true)
    expect(new URL(h.socketUrls[0]).searchParams.get("access_token")).toBe("ephemeral/test")
    expect(new URL(h.socketUrls[0]).pathname).toBe(
      "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained",
    )
  })

  test("sends one buffered Manual activity in order", async () => {
    const h = harness()
    await start(h, "manual")

    h.controller.sendActivity(["AAAA", "BBBB"], "bluetooth")

    expect(h.requests[0].body.mode).toBe("manual")
    expect(h.sockets[0].sent.slice(1).map((value) => JSON.parse(value))).toEqual([
      {realtimeInput: {activityStart: {}}},
      {realtimeInput: {audio: {data: "AAAA", mimeType: "audio/pcm;rate=16000"}}},
      {realtimeInput: {audio: {data: "BBBB", mimeType: "audio/pcm;rate=16000"}}},
      {realtimeInput: {activityEnd: {}}},
    ])
    completeTurn(h)
    await h.controller.stop()
    const events = h.requests.find(request => request.url.endsWith("/transcripts/append"))!.body.events
    expect(events.map((event: any) => event.mic_source)).toEqual(["bluetooth", undefined])
  })

  test("only successful audio sends update the selected turn source", async () => {
    const h = harness()
    h.controller.sendAudio("AAAA", "glasses")
    await start(h)
    completeTurn(h)
    h.controller.sendAudio("AAAA", "phone")
    h.controller.activityPauseReason = "Test pause"
    h.controller.sendAudio("BBBB", "glasses")
    h.controller.activityPauseReason = null
    h.sockets[0].readyState = 0
    h.controller.sendAudio("BBBB", "glasses")
    h.sockets[0].readyState = 1
    h.sockets[0].failAtSendCount = h.sockets[0].sent.length
    expect(() => h.controller.sendAudio("BBBB", "glasses")).toThrow("socket send failed")
    h.sockets[0].failAtSendCount = null
    completeTurn(h)
    h.controller.sendAudio("AAAA", "glasses")
    h.controller.sendAudio("AAAA")
    completeTurn(h)
    await h.controller.stop()
    const events = h.requests.filter(request => request.url.endsWith("/transcripts/append"))
      .flatMap(request => request.body.events)
    expect(events.map((event: any) => event.mic_source)).toEqual([undefined, undefined, "phone", undefined, undefined, undefined])
    expect(events.filter((event: any) => event.mic_source === undefined).every((event: any) => !("mic_source" in event))).toBe(true)
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
              api_version: "v1beta",
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
    h.controller.sendAudio("AAAA", "bluetoothClassic")

    h.sockets[0].message({
      serverContent: {
        inputTranscription: {text: "remember the beacon"},
        turnComplete: true,
      },
      toolCall: {
        functionCalls: [{id: "call-1", name: "recall_memory", args: {query: "beacon"}}],
      },
    })
    expect(h.events).toEqual(["toolBoundary"])
    expect(h.audio).toEqual([])
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/recall")))
    const recall = h.requests.find((request) => request.url.endsWith("/recall"))!
    expect(recall.body).toEqual({user_id: "Test User", soul_id: "Test Soul", query: "beacon"})
    expect(recall.authorization).toBeNull()

    h.sockets[0].message({serverContent: {modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}}})
    expect(h.audio).toEqual(["AAAAAA=="])
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
      serverContent: {outputTranscription: {text: "stale license"}, modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}, turnComplete: true},
    })
    await waitFor(
      () => h.requests
        .filter((request) => request.url.endsWith("/transcripts/append"))
        .flatMap((request) => request.body.events).length === 5,
    )
    const events = h.requests
      .filter((request) => request.url.endsWith("/transcripts/append"))
      .flatMap((request) => request.body.events)
    expect(events.map((event: any) => [event.role, event.content, event.status])).toEqual([
      ["user", "remember the beacon", "complete"],
      ["assistant", "I remembered it.", "complete"],
      ["user", "ordinary follow-up", "complete"],
      ["assistant", "ordinary answer", "complete"],
      ["assistant", "stale license", "complete"],
    ])
    expect(events.map((event: any) => event.mic_source)).toEqual(["bluetoothClassic", undefined, undefined, undefined, undefined])
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("mixed live tools preserve names, scopes, fresh state and explicit outcomes", async () => {
    const outcomes = [
      {ok: true, working_thoughts: ["Fictional beacon"], intentions: [{id: "intent-1", text: "Sketch the beacon"}]},
      {ok: true, status: "saved"},
      {ok: true, status: "removed", memory_ids: ["completion-memory"]},
      {ok: false, status: "not_found", message: "intention not found"},
      {ok: true, working_thoughts: ["Fictional beacon updated"], intentions: []},
    ]
    const h = harness({workingBodies: outcomes})
    await start(h)
    const calls = [
      {id: "read-1", name: "read_working_state", args: {}},
      {id: "thought-1", name: "save_working_thought", args: {thought: " Fictional beacon updated "}},
      {id: "annul-1", name: "annul_intention", args: {intention_id: "intent-1", status: "completed", note: " Done "}},
      {id: "annul-2", name: "annul_intention", args: {intention_id: "intent-2", status: "deleted"}},
      {id: "read-2", name: "read_working_state", args: {}},
      {id: "recall-mixed", name: "recall_memory", args: {query: "beacon"}},
    ]
    h.sockets[0].message({toolCall: {functionCalls: calls}})
    await waitFor(() => h.sockets[0].sent.filter(value => JSON.parse(value).toolResponse).length === calls.length)
    const responses = h.sockets[0].sent.flatMap(value => JSON.parse(value).toolResponse?.functionResponses ?? [])
    for (const [index, call] of calls.entries()) {
      expect(responses.find(response => response.id === call.id)).toEqual({
        id: call.id, name: call.name, scheduling: "SILENT",
        response: outcomes[index] ?? {result: "A compact fictional memory."},
      })
    }
    const requests = h.requests.filter(request => /\/(working-state|working-thought|annul-intention)$/.test(request.url))
    expect(requests.map(request => request.url)).toEqual([
      "working-state", "working-thought", "annul-intention", "annul-intention", "working-state",
    ].map(path => `${CONFIG.baseUrl}/integration/mentra/session/sitting-1/${path}`))
    expect(requests.map(request => request.body)).toEqual([
      {}, {thought: "Fictional beacon updated"},
      {intention_id: "intent-1", status: "completed", note: "Done"},
      {intention_id: "intent-2", status: "deleted"}, {},
    ].map(args => ({user_id: CONFIG.userId, soul_id: CONFIG.soulId, ...args})))
    expect(requests.every(request => request.authorization === null)).toBe(true)
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("working tools pass busy outcomes without retries or ending voice", async () => {
    for (const status of [200, 409]) {
      const busy = {ok: false, status: "busy", message: "busy, not saved"}
      const h = harness({workingStatus: status, workingBodies: [busy]})
      await start(h)
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "busy-write", name: "save_working_thought", args: {thought: "beacon"}},
      ]}})
      await waitFor(() => h.sockets[0].sent.some(value => JSON.parse(value).toolResponse))
      const response = JSON.parse(h.sockets[0].sent.find(value => JSON.parse(value).toolResponse)!)
      expect(response.toolResponse.functionResponses[0]).toMatchObject({response: busy, scheduling: "SILENT"})
      expect(h.requests.filter(request => request.url.endsWith("/working-thought"))).toHaveLength(1)
      expect(h.errors).toEqual([])
      await h.controller.stop()
    }
  })

  test("lost, failed or malformed write outcomes are uncertain and never automatically retried", async () => {
    for (const options of [
      {workingThrows: true}, {workingStatus: 500}, {workingStatus: 503}, {workingBodies: [{}]},
    ]) {
      const h = harness(options)
      await start(h)
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "lost-write", name: "annul_intention", args: {intention_id: "intent-1", status: "completed"}},
      ]}})
      await waitFor(() => h.sockets[0].sent.some(value => JSON.parse(value).toolResponse))
      const response = JSON.parse(h.sockets[0].sent.find(value => JSON.parse(value).toolResponse)!)
      expect(response.toolResponse.functionResponses[0]).toMatchObject({
        name: "annul_intention", response: {ok: false, status: "uncertain"}, scheduling: "SILENT",
      })
      expect(response.toolResponse.functionResponses[0].response.message).toContain("may have saved")
      expect(h.requests.filter(request => request.url.endsWith("/annul-intention"))).toHaveLength(1)
      expect(h.errors).toEqual([])
      await h.controller.stop()
    }
  })

  test("working tools validate the entire batch before admitting a write", async () => {
    for (const call of [
      {name: "read_working_state", args: {user_id: "Other User"}},
      {name: "save_working_thought", args: {thought: " "}},
      {name: "save_working_thought", args: {thought: 1}},
      {name: "annul_intention", args: {intention_id: " ", status: "completed"}},
      {name: "annul_intention", args: {intention_id: "intent-1", status: "active"}},
      {name: "annul_intention", args: {intention_id: "intent-1", status: "deleted", note: null}},
      {name: "read_working_state", args: []},
    ]) {
      const h = harness()
      await start(h)
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "valid-first", name: "save_working_thought", args: {thought: "beacon"}},
        {id: "invalid", ...call},
      ]}})
      expect(h.errors).toEqual([])
      const responses = h.sockets[0].sent.flatMap(value => JSON.parse(value).toolResponse?.functionResponses ?? [])
      expect(responses.map(response => [response.id, response.response.status, response.scheduling])).toEqual([
        ["valid-first", "invalid", "SILENT"], ["invalid", "invalid", "SILENT"],
      ])
      expect(h.requests.some(request => /\/(working-state|working-thought|annul-intention)$/.test(request.url))).toBe(false)
      await h.controller.stop()
    }
  })

  test("server argument rejection answers tools without ending voice", async () => {
    for (const name of ["save_working_thought", "recall_memory"]) {
      const h = harness({workingStatus: 422, recallStatus: 422})
      await start(h)
      h.sockets[0].message({toolCall: {functionCalls: [{id: "rejected", name,
        args: name === "recall_memory" ? {query: "x".repeat(4001)} : {thought: "x".repeat(4001)},
      }]}})
      await waitFor(() => h.sockets[0].sent.some(value => JSON.parse(value).toolResponse))
      const response = JSON.parse(h.sockets[0].sent.find(value => JSON.parse(value).toolResponse)!)
      expect(response.toolResponse.functionResponses[0]).toMatchObject({response: {ok: false, status: "invalid"}, scheduling: "SILENT"})
      expect(h.errors).toEqual([])
      await h.controller.stop()
    }
  })

  test("fatal session errors preserve unresolved write uncertainty", async () => {
    let release!: () => void
    const h = harness({workingGate: new Promise<void>(resolve => {release = resolve})})
    await start(h)
    h.sockets[0].message({toolCall: {functionCalls: [
      {id: "pending-save", name: "save_working_thought", args: {thought: "beacon"}},
    ]}})
    await waitFor(() => h.requests.some(request => request.url.endsWith("/working-thought")))
    h.sockets[0].message("not JSON")
    expect(h.errors[0]).toContain("may have saved")
    release()
    await h.controller.stop()
    expect(h.requests.filter(request => request.url.endsWith("/working-thought"))).toHaveLength(1)
  })

  test("failed reconnect retains an uncertain write answer that could not be delivered", async () => {
    let release!: () => void
    const h = harness({workingThrows: true, tokenStatuses: [401],
      tokenGate: new Promise<void>(resolve => {release = resolve}),
    })
    await start(h)
    h.sockets[0].message({toolCall: {functionCalls: [
      {id: "queued-uncertain", name: "save_working_thought", args: {thought: "beacon"}},
    ]}})
    h.sockets[0].error()
    await waitFor(() => h.persistenceErrors.some(message => message?.includes("may have saved") === true))
    expect(h.sockets[0].sent.some(value => JSON.parse(value).toolResponse)).toBe(false)
    release()
    await waitFor(() => h.errors.length > 0)
    expect(h.errors[0]).toContain("may have saved")
    await h.controller.stop()
    expect(h.requests.filter(request => request.url.endsWith("/working-thought"))).toHaveLength(1)
  })

  test("cancelled and stopped writes discard late responses without undo or replay", async () => {
    for (const action of ["cancel", "cancel-acknowledged", "stop", "restart"] as const) {
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const h = harness({workingGate: gate})
      await start(h)
      if (action === "cancel-acknowledged") admitRequest(h, "continuous")
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "late-write", name: "save_working_thought", args: {thought: "beacon"}},
      ]}})
      await waitFor(() => h.requests.some(request => request.url.endsWith("/working-thought")))
      if (action === "cancel-acknowledged") {
        release()
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      if (action === "cancel" || action === "cancel-acknowledged") h.sockets[0].message({toolCallCancellation: {ids: ["late-write"]}})
      else await h.controller.stop()
      if (action === "cancel") expect(h.persistenceErrors.some(message => message?.includes("may have saved"))).toBe(true)
      if (action === "cancel-acknowledged") expect(h.persistenceErrors.some(message => message?.includes("may have saved"))).toBe(false)
      if (action === "restart") {
        const starting = h.controller.start()
        await waitFor(() => h.sockets.length === 2)
        h.sockets[1].open()
        h.sockets[1].message({setupComplete: {}})
        await starting
      }
      release()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(h.sockets.some(socket => socket.sent.some(value => JSON.parse(value).toolResponse))).toBe(false)
      expect(h.requests.filter(request => request.url.endsWith("/working-thought"))).toHaveLength(1)
      expect(h.errors).toEqual([])
      await h.controller.stop()
    }
  })

  test("pending write result follows socket replacement without replaying the HTTP write", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const h = harness({workingGate: gate})
    await start(h)
    h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "fictional-handle"}})
    h.sockets[0].message({toolCall: {functionCalls: [
      {id: "replacement-write", name: "save_working_thought", args: {thought: "beacon"}},
    ]}})
    await waitFor(() => h.requests.some(request => request.url.endsWith("/working-thought")))
    h.sockets[0].error()
    await waitFor(() => h.sockets.length === 2)
    h.sockets[1].open()
    h.sockets[1].message({setupComplete: {}})
    release()
    await waitFor(() => h.sockets[1].sent.some(value => JSON.parse(value).toolResponse))
    expect(h.sockets[0].sent.some(value => JSON.parse(value).toolResponse)).toBe(false)
    expect(h.requests.filter(request => request.url.endsWith("/working-thought"))).toHaveLength(1)
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("working reads fail closed for an ended sitting and respect pause", async () => {
    for (const status of [404, 409]) {
      const h = harness({workingStatus: status, workingBodies: [{detail: {
        code: "soul_paused", message: "Fictional Soul is paused. Retry in OpenAlma launcher.",
      }}]})
      await start(h)
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "read-admission", name: "read_working_state", args: {}},
      ]}})
      if (status === 404) {
        await waitFor(() => h.errors.length > 0)
        expect(h.errors).toEqual(["OpenAlma working-state tool failed (404)"])
        expect(h.sockets[0].sent.some(value => JSON.parse(value).toolResponse)).toBe(false)
      } else {
        await waitFor(() => h.sockets[0].sent.some(value => JSON.parse(value).toolResponse))
        expect(h.controller.activityPauseReason).toContain("paused")
        expect(h.errors).toEqual([])
      }
      await h.controller.stop()
    }
  })

  test("pending writes do not block provider audio or tool-boundary speech", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const h = harness({workingGate: gate})
    await start(h)
    h.sockets[0].message({
      serverContent: {inputTranscription: {text: "Remember the beacon"}, turnComplete: true},
      toolCall: {functionCalls: [{id: "audio-write", name: "save_working_thought", args: {thought: "beacon"}}]},
    })
    await waitFor(() => h.requests.some(request => request.url.endsWith("/working-thought")))
    h.sockets[0].message({serverContent: {modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}}})
    expect(h.audio).toEqual(["AAAAAA=="])
    release()
    await waitFor(() => h.sockets[0].sent.some(value => JSON.parse(value).toolResponse))
    h.sockets[0].message({serverContent: {outputTranscription: {text: "The beacon matters"}, turnComplete: true}})
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("temporary recall failure is SILENT and nonfatal", async () => {
    for (const status of [429, 500, 502, 503]) {
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

  test("a paused recall leaves the admitted response alive and Stop skips new reflection", async () => {
    const h = harness({recallStatus: 409, recallBody: {detail: {
      code: "soul_paused", message: "Test Soul is paused. Retry in OpenAlma launcher.",
    }}})
    await start(h)
    completeTurn(h)
    completeTurn(h)
    h.sockets[0].message({toolCall: {functionCalls: [{id: 'paused-recall', name: 'recall_memory', args: {query: 'Test'}}]}})
    await waitFor(() => h.sockets[0].sent.some(value => JSON.parse(value).toolResponse))
    expect(h.errors).toEqual([])
    expect(h.sockets[0].readyState).toBe(1)
    await h.controller.stop(true)
    expect(h.sockets[0].sent.some(value => textTurn(JSON.parse(value)))).toBe(false)
    expect(h.requests.some(request => request.url.endsWith('/end'))).toBe(true)
  })

  test("a discarded recall cannot pause a replacement sitting", async () => {
    for (const action of ["cancel", "restart"] as const) {
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const h = harness({recallGate: gate, recallStatus: 409, recallBody: {detail: {
        code: "soul_paused", message: "Old sitting pause",
      }}})
      await start(h)
      h.sockets[0].message({toolCall: {functionCalls: [
        {id: "old-recall", name: "recall_memory", args: {query: "beacon"}},
      ]}})
      await waitFor(() => h.requests.some(request => request.url.endsWith("/recall")))
      if (action === "cancel") h.sockets[0].message({toolCallCancellation: {ids: ["old-recall"]}})
      else {
        await h.controller.stop()
        const starting = h.controller.start()
        await waitFor(() => h.sockets.length === 2)
        h.sockets[1].open()
        h.sockets[1].message({setupComplete: {}})
        await starting
      }
      release()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(h.controller.activityPauseReason).toBeNull()
      expect(h.persistenceErrors.filter(message => message === "Old sitting pause")).toEqual([])
      expect(h.errors).toEqual([])
      await h.controller.stop()
    }
  })

  test("recall scope, internal, and config failures are fatal without exposing the query", async () => {
    for (const status of [401, 403, 404, 409]) {
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
    await waitFor(() => h.sockets[0].sent.some((value) => textTurn(JSON.parse(value))))
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    h.sockets[0].message({
      serverContent: {outputTranscription: {text: "NO_SUMMARY"}, turnComplete: true},
    })
    await stopping

    expect(h.sockets[0].sent.some((value) => JSON.parse(value).toolResponse)).toBe(false)
    expect(h.errors).toEqual([])
  })

  test("unknown tools and heard replies without assistant transcription fail loud", async () => {
    const unknown = harness()
    await start(unknown)
    unknown.sockets[0].message({
      toolCall: {functionCalls: [{id: "call-x", name: "other_tool", args: {query: "x"}}]},
    })
    expect(unknown.errors).toEqual(["Gemini returned unknown tool call"])
    await unknown.controller.stop()

    const ordinary = harness()
    await start(ordinary)
    ordinary.sockets[0].message({
      serverContent: {inputTranscription: {text: "ordinary unfinished reply"},
        modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}, turnComplete: true},
    })
    expect(ordinary.errors).toEqual(["Gemini completed audible speech without its transcription"])
    await ordinary.controller.stop()
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
      h.controller.sendAudio("AAAA", "glasses")
      h.sockets[0].message({serverContent: {inputTranscription: {text: "first question"}}})
      h.sockets[0].message({serverContent: {outputTranscription: {text: "partial answer"}, modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}}})
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
      expect(appends[0].body.events.map((event: any) => event.mic_source)).toEqual(["glasses", undefined, undefined, undefined])
      expect(h.events).toEqual(["interrupted", "turnComplete", "turnComplete"])
      expect(consoleInfo).toHaveBeenCalledWith(
        expect.stringContaining("provider.interrupted"),
        {audioChunks: 1, inputChars: 14, outputChars: 14},
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
    h.sockets[0].message({serverContent: {outputTranscription: {text: "partial answer"}, modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}}})
    h.sockets[0].message({serverContent: {interrupted: true}})
    h.sockets[0].message({serverContent: {turnComplete: true}})
    completeTurn(h, "second question", "second answer")
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/transcripts/append")))

    const stopping = h.controller.stop(true)
    await waitFor(() => h.sockets[0].sent.some((value) => textTurn(JSON.parse(value))))
    h.sockets[0].message({serverContent: {outputTranscription: {text: "NO_SUMMARY"}, turnComplete: true}})
    await stopping
  })

  test.each([false, true])("missing assistant text is a gap only after heard PCM (audible=%s)", async audible => {
    const h = harness()
    await start(h)
    h.controller.sendAudio("AAAA", "phone")
    h.sockets[0].message({serverContent: {inputTranscription: {text: "only one side"},
      ...(audible ? {modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}} : {}), turnComplete: true}})
    expect(h.audio).toEqual(audible ? ["AAAAAA=="] : [])
    expect(h.errors).toEqual(audible ? ["Gemini completed audible speech without its transcription"] : [])
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/transcripts/append")))
    expect(h.requests.find((request) => request.url.endsWith("/transcripts/append"))?.body.events).toEqual([
      expect.objectContaining({event_kind: "transcript", role: "user", content: "only one side", mic_source: "phone"}),
      ...(audible ? [expect.objectContaining({event_kind: "transcript_gap", role: "assistant", content: "Transcript unavailable."})] : []),
    ])
    if (audible) expect(h.requests.find(request => request.url.endsWith("/transcripts/append"))!.body.events[1]).not.toHaveProperty("mic_source")
    await h.controller.stop()
  })

  test("retains a failed append and retries the whole contiguous queue on the next turn", async () => {
    const h = harness({appendStatuses: [503, 200]})
    await start(h)
    h.controller.sendAudio("AAAA", "glasses")
    completeTurn(h, "one", "answer one")
    await waitFor(() => h.persistenceErrors.length === 1)
    h.controller.sendAudio("AAAA", "phone")
    completeTurn(h, "two", "answer two")
    await waitFor(() => h.persistenceErrors.at(-1) === null)

    const appends = h.requests.filter((request) => request.url.endsWith("/transcripts/append"))
    expect(appends.map((request) => request.body.events.length)).toEqual([2, 4])
    expect(appends[1].body.events.map((event: any) => event.mic_source)).toEqual(["glasses", undefined, "phone", undefined])
    expect(appends[1].body.events.slice(0, 2)).toEqual(appends[0].body.events)
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("writes the existing outbox journal before transcript append", async () => {
    let release!: () => void
    const storage = new FakeStorage()
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness({storage})
    await start(h)
    const before = storage.setCalls
    storage.setGate = gate
    completeTurn(h)
    await waitFor(() => storage.setCalls === before + 1)
    expect(h.requests.some((request) => request.url.endsWith("/transcripts/append"))).toBe(false)
    release()
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/transcripts/append")))
    await h.controller.stop()
  })

  test("records new turns while a prior server append is still waiting", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {release = resolve})
    const storage = new FakeStorage()
    const h = harness({storage, appendGates: [gate]})
    await start(h)
    h.controller.sendAudio("AAAA", "glasses")
    completeTurn(h, "first", "first answer")
    await waitFor(() => h.requests.some(request => request.url.endsWith("/transcripts/append")))
    h.controller.sendAudio("AAAA", "phone")
    completeTurn(h, "second", "second answer")
    await waitFor(() => JSON.parse(storage.values.get(JOURNAL_KEY) ?? "{}").pendingTranscripts?.length === 4)
    expect(JSON.parse(storage.values.get(JOURNAL_KEY)!).pendingTranscripts.map((event: any) => event.mic_source))
      .toEqual(["glasses", undefined, "phone", undefined])
    expect(h.requests.filter(request => request.url.endsWith("/transcripts/append"))).toHaveLength(1)
    release()
    await h.controller.stop()
  })

  test("serializes a pending photo write and its Discard without resurrecting the photo", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {release = resolve})
    const storage = new FakeStorage()
    const h = harness({storage})
    await start(h)
    const before = storage.setCalls
    storage.setGate = gate
    const sending = h.controller.sendImage({imageId: "serial-photo", mimeType: "image/png", data: "AQID"})
    void sending.catch(() => {})
    await waitFor(() => storage.setCalls === before + 1)
    const discard = h.controller.discardImage()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(storage.setCalls).toBe(before + 1)
    release()
    await discard
    await expect(sending).rejects.toThrow("Photo send cancelled")
    expect(storage.values.get(JOURNAL_KEY)).toBe("")
    expect(h.sockets[0].sent.some(value => textTurn(JSON.parse(value)))).toBe(false)
    await h.controller.stop()
  })

  test.each(["read", "archive"])("a failed %s preserves the original backup while a fresh sitting saves separately", async failure => {
    const storage = new FakeStorage()
    const raw = "{unreadable original backup"
    storage.values.set(JOURNAL_KEY, raw)
    const read = storage.get.bind(storage)
    const save = storage.set.bind(storage)
    let oldReads = 0
    storage.get = async key => {
      if (key === JOURNAL_KEY) {oldReads += 1; if (failure === "read") throw new Error("Read failed")}
      return read(key)
    }
    storage.set = async (key, value) => {
      if (failure === "archive" && key === RECOVERED_CHATS_KEY) throw new Error("Archive failed")
      await save(key, value)
    }
    const h = harness({storage, appendStatuses: Array(100).fill(503)})
    await start(h)
    completeTurn(h, "Fresh fictional speech", "A fresh reply")
    await waitFor(() => [...storage.values].some(([key, value]) => key !== JOURNAL_KEY && value.includes("Fresh fictional speech")))
    expect(storage.values.get(JOURNAL_KEY)).toBe(raw)
    expect(storage.values.has(RECOVERED_CHATS_KEY)).toBe(false)
    await h.controller.stop()
    const oldReadsBeforeReopen = oldReads
    const reopened = harness({storage})
    await start(reopened)
    await reopened.controller.stop()
    const again = harness({storage})
    await start(again)
    await again.controller.stop()
    expect(oldReads).toBe(oldReadsBeforeReopen)
    expect(storage.values.get(JOURNAL_KEY)).toBe(raw)
  })

  test("a host returning null for an existing unreadable key cannot erase its backup", async () => {
    const storage = new FakeStorage()
    const raw = "existing backup behind a failed host read"
    storage.values.set(JOURNAL_KEY, raw)
    const read = storage.get.bind(storage)
    storage.get = async key => key === JOURNAL_KEY ? null : read(key)
    const h = harness({storage})
    await start(h)
    await h.controller.stop()
    expect(storage.values.get(JOURNAL_KEY)).toBe(raw)
  })

  test("a masked failed read of recovered chats cannot overwrite either backup", async () => {
    const storage = new FakeStorage()
    storage.values.set(JOURNAL_KEY, "unreadable active backup")
    storage.values.set(RECOVERED_CHATS_KEY, "existing recovered backup")
    const read = storage.get.bind(storage)
    storage.get = async key => key === RECOVERED_CHATS_KEY ? null : read(key)
    const h = harness({storage})
    await start(h)
    await h.controller.stop()
    expect(storage.values.get(JOURNAL_KEY)).toBe("unreadable active backup")
    expect(storage.values.get(RECOVERED_CHATS_KEY)).toBe("existing recovered backup")
  })

  test.each(["valid", "invalid", "failed", "keys", "archive"])("Stop during pending %s journal I/O preserves the original and cannot bootstrap", async outcome => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {release = resolve})
    const storage = new FakeStorage()
    const raw = outcome === "invalid" || outcome === "archive" ? "not JSON" : JSON.stringify({version: 1,
      scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
      resumption: null, pendingTranscripts: []})
    storage.values.set(JOURNAL_KEY, raw)
    let reading = false
    if (outcome === "keys") storage.keys = async () => {reading = true; await gate; return [...storage.values.keys()]}
    else if (outcome === "archive") storage.set = async () => {reading = true; await gate; throw new Error("Archive failed")}
    else storage.get = async () => {reading = true; await gate; if (outcome === "failed") throw new Error("Read failed"); return raw}
    const h = harness({storage})
    const starting = h.controller.start()
    void starting.catch(() => {})
    await waitFor(() => reading)
    const stopping = h.controller.stop()
    if (outcome !== "archive") await stopping
    release()
    await stopping
    await expect(starting).rejects.toThrow("Gemini start cancelled")
    expect(storage.values.get(JOURNAL_KEY)).toBe(raw)
    expect(storage.values.has(RECOVERED_CHATS_KEY)).toBe(false)
    expect(h.requests).toHaveLength(0)
  })

  test("unavailable local storage cannot block Start or server transcript saving and can recover", async () => {
    const storage = new FakeStorage()
    const raw = "Preserved fictional original"
    storage.values.set(JOURNAL_KEY, raw)
    const keys = storage.keys.bind(storage)
    storage.keys = async () => {throw new Error("Storage unavailable")}
    const history: NonNullable<Parameters<typeof harness>[0]>["history"] = []
    const h = harness({storage, history})
    await start(h)
    completeTurn(h, "Speech while local storage is off", "First reply")
    await waitFor(() => history.length === 2)
    expect(h.persistenceErrors.at(-1)).toBe("Local transcript backup unavailable")
    storage.keys = keys
    completeTurn(h, "Speech after storage returns", "Second reply")
    await waitFor(() => history.length === 4 && h.persistenceErrors.at(-1) === null)
    await h.controller.stop()
    expect(storage.values.get(JOURNAL_KEY)).toBe(raw)
    expect(storage.values.get(`${JOURNAL_KEY}:1`)).toBe("")
    expect(h.errors).toEqual([])
  })

  test("preserves malformed recovery-area bytes and survives a lost archive acknowledgement", async () => {
    const storage = new FakeStorage()
    const raw = "unreadable journal"
    const older = "unreadable recovered chats"
    storage.values.set(JOURNAL_KEY, raw)
    storage.values.set(RECOVERED_CHATS_KEY, older)
    const save = storage.set.bind(storage)
    let loseAck = true
    storage.set = async (key, value) => {
      await save(key, value)
      if (key === RECOVERED_CHATS_KEY && loseAck) {loseAck = false; throw new Error("Archive acknowledgement lost")}
    }
    const first = harness({storage})
    await start(first)
    await first.controller.stop()
    expect(storage.values.get(JOURNAL_KEY)).toBe(raw)
    const restarted = harness({storage})
    await start(restarted)
    expect(JSON.parse(storage.values.get(RECOVERED_CHATS_KEY)!)).toEqual([older, raw])
    expect(storage.values.get(JOURNAL_KEY)).toBe(raw)
    await restarted.controller.stop()
  })

  test("replays more than 512 valid retained lines without deleting or renumbering them", async () => {
    const storage = new FakeStorage()
    const rows = Array.from({length: 520}, (_, index) => ({event_id: `old:${index + 41}`,
      sequence: index + 41, event_kind: "transcript", role: "user", status: "complete", content: `retained ${index}`}))
    storage.values.set(JOURNAL_KEY, JSON.stringify({version: 1,
      scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
      resumption: null, pendingTranscripts: rows}))
    const history: NonNullable<Parameters<typeof harness>[0]>["history"] = []
    const h = harness({storage, history})
    await start(h)
    await h.controller.stop()
    expect(history.map((event: any) => event.sequence)).toEqual(rows.map(row => row.sequence))
    expect(history.map(event => event.content)).toEqual(rows.map(row => row.content))
    expect(storage.values.has(RECOVERED_CHATS_KEY)).toBe(false)
  })

  test("photo-only backup outside restored history is archived before any finalization", async () => {
    const storage = new FakeStorage()
    const raw = JSON.stringify({version: 1,
      scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
      resumption: {handle: "must-not-resume", updatedAt: Date.now()}, pendingTranscripts: [],
      pendingImage: {imageId: "old-photo", mediaRef: "mentra_media/test-phone/old-photo.png",
        providerSent: true, captureAfterCurrent: false, generation: 1, sessionId: "old",
        imageSequence: 41, caption: "A retained description", assistantSequence: 42}})
    storage.values.set(JOURNAL_KEY, raw)
    const h = harness({storage, startBody: {session_id: "restored", next_transcript_sequence: 1,
      ephemeral_token: "ephemeral/test", websocket: {api_version: "v1beta", method: "BidiGenerateContentConstrained",
        input_audio_rate_hz: 16000, output_audio_rate_hz: 24000}, lease_seconds: 90, session_warning_seconds: 0}})
    await start(h)
    expect(JSON.parse(storage.values.get(RECOVERED_CHATS_KEY)!)).toEqual([raw])
    expect(h.requests.some(request => request.url.endsWith("/snapshot/finalize"))).toBe(false)
    expect(JSON.parse(h.sockets[0].sent[0])).toEqual({setup: {sessionResumption: {}}})
    await h.controller.stop()
  })

  test("a refused caption uses ordinary Retry without repeated finalization or losing its event", async () => {
    const storage = new FakeStorage()
    const caption = "description ".repeat(1_300).trim()
    const h = harness({storage, finalizeStatuses: [422]})
    await start(h)
    await h.controller.sendImage({imageId: "long-caption", mimeType: "image/png", data: "AQID"})
    saveCaption(h.sockets[0], "long-caption", caption)
    await waitFor(() => h.photoRetryChanges.at(-1) === true)
    const recovered = JSON.parse(storage.values.get(JOURNAL_KEY)!)
    expect(recovered.pendingImage.caption).toBe(caption)
    expect(recovered.pendingImage.captionEventId).toBe("sitting-1:photo:long-caption")
    const saved = h.requests.filter(request => request.url.endsWith("/transcripts/append")).flatMap(request => request.body.events)
    expect(saved.filter(event => event.role === "assistant").map(event => event.content).join("")).toBe(caption)
    expect(storage.values.has(RECOVERED_CHATS_KEY)).toBe(false)
    completeTurn(h, "Keep talking", "A later reply")
    await waitFor(() => h.requests.some(request => request.body.events?.some((event: {content: string}) => event.content === "A later reply")))
    expect(h.requests.filter(request => request.url.endsWith("/snapshot/finalize"))).toHaveLength(1)
    await h.controller.discardImage()
    await h.controller.sendImage({imageId: "next-photo", mimeType: "image/png", data: "AQID"})
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("splits long Unicode speech without truncating its text or boundary whitespace", async () => {
    const text = "a" + " ".repeat(32_000) + "b" + "\u{1f642}".repeat(16_001)
    const history: NonNullable<Parameters<typeof harness>[0]>["history"] = []
    const h = harness({storage: new FakeStorage(), history})
    await start(h)
    h.controller.sendAudio("AAAA", "phone")
    completeTurn(h, text, "A short answer")
    h.controller.sendAudio("AAAA", "glasses")
    await h.controller.stop()
    const spoken = history.filter(event => event.role === "user")
    expect(spoken.map(event => event.content).join("")).toBe(text)
    expect(spoken.every(event => Array.from(event.content).length <= 16_000)).toBe(true)
    expect(spoken.every(event => event.mic_source === "phone")).toBe(true)
    expect(history.filter(event => event.role === "assistant").every(event => !("mic_source" in event))).toBe(true)
  })

  test("photo finalization refusal and Discard do not poison or hide speech sync", async () => {
    const h = harness({storage: new FakeStorage(), finalizeStatuses: [400], appendStatuses: [200, 200, 503, 200]})
    await start(h)
    await h.controller.sendImage({imageId: "refused-photo", mimeType: "image/png", data: "AQID"})
    saveCaption(h.sockets[0], "refused-photo", "A small fictional square.")
    await waitFor(() => h.photoRetryChanges.at(-1) === true)
    expect(h.errors).toEqual([])
    completeTurn(h, "keep talking", "still heard")
    await waitFor(() => h.persistenceErrors.at(-1) === "Transcript sync failed; retrying")
    await h.controller.discardImage()
    expect(h.persistenceErrors.at(-1)).not.toBeNull()
    completeTurn(h, "try again", "stored now")
    await waitFor(() => h.persistenceErrors.at(-1) === null)
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("successful caption Retry cannot hide a later speech-sync failure", async () => {
    const h = harness({storage: new FakeStorage(), finalizeStatuses: [503, 200], appendStatuses: [200, 200, 503]})
    await start(h)
    await h.controller.sendImage({imageId: "caption-retry", mimeType: "image/png", data: "AQID"})
    saveCaption(h.sockets[0], "caption-retry", "A small fictional triangle.")
    await waitFor(() => h.photoRetryChanges.at(-1) === true)
    completeTurn(h, "later question", "later answer")
    await waitFor(() => h.persistenceErrors.at(-1) === "Transcript sync failed; retrying")
    await h.controller.retryImage()
    expect(h.photoRetryChanges.at(-1)).toBe(false)
    expect(h.persistenceErrors.at(-1)).not.toBeNull()
    expect(h.errors).toEqual([])
    await h.controller.stop()
  })

  test("successful photo replay cannot hide failed speech sync", async () => {
    const storage = new FakeStorage()
    storage.values.set(JOURNAL_KEY, JSON.stringify({version: 1,
      scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
      resumption: null,
      pendingTranscripts: [42, 43].map(sequence => ({event_id: `old:${sequence}`, sequence,
        event_kind: "transcript", role: "user", status: "complete", content: "Retained fictional speech"})),
      pendingImage: {imageId: "retained-photo", mediaRef: "mentra_media/test-phone/retained-photo.png",
        providerSent: false, captureAfterCurrent: false, generation: 1, sessionId: "old", imageSequence: 41}}))
    let release!: () => void
    const gate = new Promise<void>(resolve => {release = resolve})
    const h = harness({storage, startSequence: 42, appendStatuses: [503, 503], appendGates: [Promise.resolve(), gate]})
    try {
      await start(h)
      await waitFor(() => h.persistenceErrors.at(-1) === "Transcript sync failed; retrying")
      await waitFor(() => h.sockets[0].sent.some(value => photoInput(JSON.parse(value))))
      expect(h.photoRetryChanges.at(-1)).toBe(false)
      expect(h.persistenceErrors.at(-1)).not.toBeNull()
    } finally {
      release()
      await h.controller.stop()
    }
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
            mic_source: "glasses",
          },
          {
            event_id: "old-sitting:41",
            sequence: 41,
            event_kind: "transcript",
            role: "assistant",
            content: "unacknowledged suffix",
            status: "complete",
          },
          {
            event_id: "old-sitting:42",
            sequence: 42,
            event_kind: "transcript",
            role: "user",
            content: "unacknowledged speech",
            status: "interrupted",
            mic_source: "bluetooth",
          },
        ],
      }),
    )
    const savedJournal = storage.values.get("openalma:gemini-session-v1")!
    const h = harness({
      storage,
      startBody: {
        session_id: "replacement-sitting",
        next_transcript_sequence: 41,
        ephemeral_token: "ephemeral/test",
        websocket: {
          api_version: "v1beta",
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
      expect.objectContaining({
        event_id: "replacement-sitting:42",
        sequence: 42,
        content: "unacknowledged speech",
        mic_source: "bluetooth",
      }),
    ])
    await waitFor(() => {
      const raw = storage.values.get("openalma:gemini-session-v1")
      return Boolean(raw && JSON.parse(raw).pendingTranscripts.length === 0)
    })
    await h.controller.stop(true)
    expect(storage.values.get("openalma:gemini-session-v1")).toBe("")

    const recovery = JSON.parse(savedJournal)
    recovery.pendingImage = {imageId: "pending-photo", mediaRef: "mentra_media/TestSoul/photo.png",
      providerSent: false, captureAfterCurrent: false, generation: 1, sessionId: "old-sitting"}
    storage.values.set("openalma:gemini-session-v1", JSON.stringify(recovery))
    const gap = harness({storage, startBody: {
      session_id: "different-history", next_transcript_sequence: 39, ephemeral_token: "ephemeral/test",
      websocket: {api_version: "v1beta", method: "BidiGenerateContentConstrained",
        input_audio_rate_hz: 16000, output_audio_rate_hz: 24000},
      lease_seconds: 90, session_warning_seconds: 0,
    }})
    await start(gap)
    expect(JSON.parse(storage.values.get(RECOVERED_CHATS_KEY)!)).toContain(JSON.stringify(recovery))
    expect(storage.values.get(JOURNAL_KEY)).toBe("")
    expect(JSON.parse(gap.sockets[0].sent[0])).toEqual({setup: {sessionResumption: {}}})
    expect(gap.requests.some((request) => request.url.endsWith("/transcripts/append"))).toBe(false)
    await gap.controller.stop()
    expect(gap.requests.some((request) => request.url.endsWith("/different-history/end"))).toBe(true)
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
    expect(storage.values.get("openalma:gemini-session-v1")).toBe("")
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

  test.each([
    {name: "missing status", fields: {}},
    {name: "unknown source", fields: {status: "complete", mic_source: "unknown"}},
    {name: "empty source", fields: {status: "complete", mic_source: ""}},
    {name: "null source", fields: {status: "complete", mic_source: null}},
    {name: "assistant source", fields: {status: "complete", role: "assistant", mic_source: "phone"}},
    {name: "gap source", fields: {event_kind: "transcript_gap", content: "Transcript unavailable.", mic_source: "phone"}},
    {name: "summary source", fields: {event_kind: "sitting_summary", role: "assistant", mic_source: "phone"}},
    {name: "image source", fields: {event_kind: "image", content: "Shared a photo.",
      media_ref: "mentra_media/test-phone/image.png", mic_source: "phone"}},
  ])("archives a journal event that mcp would reject without replaying it ($name)", async ({fields}) => {
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
            ...fields,
          },
        ],
      }),
    )
    const original = storage.values.get(JOURNAL_KEY)!
    const h = harness({storage})
    await start(h)
    expect(JSON.parse(h.sockets[0].sent[0])).toEqual({setup: {sessionResumption: {}}})
    expect(storage.values.get("openalma:gemini-session-v1")).toBe("")
    expect(JSON.parse(storage.values.get(RECOVERED_CHATS_KEY)!)[0]).toBe(original)
    await h.controller.stop()
  })

  test.each(["duplicate reservations", "preassigned draft ID"] as const)("archives malformed draft journal: %s", async malformed => {
    const reservation = {event_kind: "transcript", role: "user", content: "", status: "complete",
      speech: {waiting: true, late: true, uncertain: false, ended: true, admitted: true}}
    const drafts = malformed === "duplicate reservations" ? [reservation, reservation] : [{
      event_id: "old:photo:premature", event_kind: "photo_caption", role: "assistant",
      content: "A caption with a premature timeline ID.", media_ref: "mentra_media/test-phone/premature.png",
    }]
    const raw = JSON.stringify({version: 1,
      scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
      resumption: {handle: "must-not-resume", updatedAt: Date.now()},
      pendingTranscripts: [], draftTranscripts: drafts, nextTranscriptSequence: 41})
    const storage = new FakeStorage()
    storage.values.set(JOURNAL_KEY, raw)
    const h = harness({storage})
    await start(h)
    expect(JSON.parse(h.sockets[0].sent[0])).toEqual({setup: {sessionResumption: {}}})
    expect(JSON.parse(storage.values.get(RECOVERED_CHATS_KEY)!)).toEqual([raw])
    expect(h.requests.some(request => request.url.endsWith("/transcripts/append"))).toBe(false)
    completeTurn(h, "A new fictional question.", "An unrelated answer.")
    await h.controller.stop()
    expect(h.requests.flatMap(request => request.body.events ?? []).map(row => row.content))
      .toEqual(["A new fictional question.", "An unrelated answer."])
    expect(h.errors).toEqual([])
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
    const h = harness({storage: new FakeStorage(), appendStatuses: [503, 503]})
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
    h.controller.sendAudio("AAAA", "phone")
    h.sockets[0].message({serverContent: {inputTranscription: {text: "partial question"}}})
    h.sockets[0].message({serverContent: {outputTranscription: {text: "partial answer"}, modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}}})
    await h.controller.stop()

    const append = h.requests.find((request) => request.url.endsWith("/transcripts/append"))!
    expect(append.body.events.map((event: any) => [event.content, event.status])).toEqual([
      ["partial question", "interrupted"],
      ["partial answer", "interrupted"],
    ])
    expect(append.body.events.map((event: any) => event.mic_source)).toEqual(["phone", undefined])
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
    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_START"}})
    h.sockets[0].message({serverContent: {inputTranscription: {text: "partial question"}}})
    h.sockets[0].message({serverContent: {outputTranscription: {text: "partial answer"}, modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}}})

    await h.controller.stop(true)
    expect(h.sockets[0].sent.some((value) => textTurn(JSON.parse(value)))).toBe(false)
    const events = h.requests
      .filter((request) => request.url.endsWith("/transcripts/append"))
      .flatMap((request) => request.body.events)
    expect(events.slice(-2).map((event: any) => event.status)).toEqual(["interrupted", "interrupted"])
  })

  test("Stop resumes its paced flush after reconnect and waits for the preceding native response", async () => {
    const storage = new FakeStorage()
    const h = harness({storage, photoDrainTimeoutMs: 3_500})
    await start(h)
    h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "flush-resumption"}})
    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_START"}})
    h.controller.sendAudio("AAAA", "phone")
    await h.controller.sendImage({imageId: "flush-recovery", mimeType: "image/png", data: "AQID"})
    const flushing = new Promise<void>(resolve => {
      const send = h.sockets[0].send.bind(h.sockets[0])
      h.sockets[0].send = data => {
        send(data)
        if (h.sockets[0].sent.filter(value => JSON.parse(value).realtimeInput?.audio).length >= 3) resolve()
      }
    })
    const stopping = h.controller.stop(true)
    try {
      await flushing
      h.sockets[0].close()
      await waitFor(() => h.sockets.length === 2)
      const flushed = new Promise<void>(resolve => {
        const send = h.sockets[1].send.bind(h.sockets[1])
        h.sockets[1].send = data => {
          send(data)
          if (JSON.parse(data).realtimeInput?.audioStreamEnd) resolve()
        }
      })
      h.sockets[1].open()
      h.sockets[1].message({setupComplete: {}})
      await flushed
      expect(h.sockets.flatMap(socket => socket.sent).filter(value => JSON.parse(value).realtimeInput?.audio)).toHaveLength(19)
      expect(h.sockets.flatMap(socket => socket.sent).some(value => photoInput(JSON.parse(value)))).toBe(false)
      h.sockets[1].message({voiceActivity: {type: "ACTIVITY_END"}})
      h.sockets[1].message({serverContent: {inputTranscription: {text: "A late fictional question."}, generationComplete: true}})
      expect(h.sockets[1].sent.some(value => photoInput(JSON.parse(value)))).toBe(false)
      h.sockets[1].message({serverContent: {turnComplete: true}})
      await waitFor(() => h.sockets[1].sent.some(value => photoInput(JSON.parse(value))))
      saveCaption(h.sockets[1], "flush-recovery", "A fictional blue square.")
      await waitFor(() => functionResponses(h.sockets[1]).length === 1)
      h.sockets[1].message({serverContent: {turnComplete: true}})
      await stopping
      const rows = h.requests.flatMap(request => request.body.events ?? [])
      expect(rows.some(row => row.role === "user" && row.content === "A late fictional question.")).toBe(true)
      expect(h.finalizations.filter(result => result.durable)).toHaveLength(1)
      expect(h.audio).toEqual([])
      expect(h.errors).toEqual([])
    } finally {
      await stopping
    }
  })

  test("confirmed interruption during Stop recovers the same photo without treating Stop itself as interruption", async () => {
    const h = harness({storage: new FakeStorage(), photoDrainTimeoutMs: 500})
    await start(h)
    await h.controller.sendImage({imageId: "interrupted-drain", mimeType: "image/png", data: "AQID"})
    const stopping = h.controller.stop(true)
    try {
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(h.sockets[0].sent.filter(value => photoInput(JSON.parse(value)))).toHaveLength(1)
      h.sockets[0].message({serverContent: {interrupted: true, turnComplete: true}})
      await waitFor(() => h.sockets[0].sent.filter(value => photoInput(JSON.parse(value))).length === 2)
      expect(h.requests.filter(request => request.url.endsWith("/snapshot/replay")).map(request => request.body.image_id))
        .toEqual(["interrupted-drain"])
      saveCaption(h.sockets[0], "interrupted-drain", "A fictional blue square.")
      await waitFor(() => functionResponses(h.sockets[0]).length === 1)
      h.sockets[0].message({serverContent: {turnComplete: true}})
      await stopping
      expect(h.finalizations.filter(result => result.durable)).toHaveLength(1)
      expect(h.errors).toEqual([])
    } finally {
      await stopping
    }
  })

  test.each(["snapshot", "journal", "replay"])("graceful Stop drains late photo %s before reflection", async (phase) => {
    let finishSnapshot!: () => void
    const snapshotGate = new Promise<void>((resolve) => { finishSnapshot = resolve })
    const storage = new FakeStorage()
    if (phase === "replay") storage.values.set("openalma:gemini-session-v1", JSON.stringify({
      version: 1, scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
      resumption: {handle: "", updatedAt: 0}, pendingTranscripts: [],
      pendingImage: {imageId: "late-photo", mediaRef: "mentra_media/test-phone/late-photo.png",
        providerSent: false, captureAfterCurrent: false, generation: 1, sessionId: "old-sitting", retryRequested: true},
    }))
    const h = harness({snapshotGate: phase === "snapshot" ? snapshotGate : undefined,
      replayGates: phase === "replay" ? [snapshotGate] : [], storage, photoDrainTimeoutMs: phase === "replay" ? 2_500 : 200})
    await start(h)
    completeTurn(h, "one", "answer one")
    completeTurn(h, "two", "answer two")
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/transcripts/append")))

    const writes = storage.setCalls
    if (phase === "journal") storage.setGate = snapshotGate
    const sending = phase === "replay" ? h.controller.retryImage()
      : h.controller.sendImage({imageId: "late-photo", mimeType: "image/png", data: "AQID"})
    await waitFor(() => phase === "journal" ? storage.setCalls > writes
      : h.requests.some((request) => request.url.endsWith(phase === "replay" ? "/snapshot/replay" : "/snapshot")))
    let inputFlushed: Promise<void> | undefined
    if (phase === "replay") {
      h.controller.sendAudio("AAAA", "phone")
      inputFlushed = new Promise<void>(resolve => {
        const send = h.sockets[0].send.bind(h.sockets[0])
        h.sockets[0].send = data => {
          send(data)
          if (JSON.parse(data).realtimeInput?.audioStreamEnd) resolve()
        }
      })
    }
    const stopping = h.controller.stop(true)
    expect(h.sockets[0].sent.some(value => textTurn(JSON.parse(value)))).toBe(false)
    finishSnapshot()
    storage.setGate = null
    await sending
    if (inputFlushed) {
      expect(h.sockets[0].sent.some(value => photoInput(JSON.parse(value)))).toBe(false)
      await inputFlushed
    }
    await waitFor(() => h.sockets[0].sent.some(value => photoInput(JSON.parse(value))))
    if (phase === "replay") {
      const messages = h.sockets[0].sent.map(value => JSON.parse(value))
      const streamEnd = messages.findIndex(message => message.realtimeInput?.audioStreamEnd)
      const image = messages.findIndex(message => photoInput(message))
      const task = messages.findIndex(message => photoTask(message))
      expect(streamEnd).toBeGreaterThan(-1)
      expect(streamEnd).toBeLessThan(image)
      expect(image).toBe(task)
      expect(messages.filter(message => message.realtimeInput?.audio)).toHaveLength(19)
    }
    saveCaption(h.sockets[0], "late-photo", "An internal perception before reflection.")
    h.sockets[0].message({serverContent: {turnComplete: true}})
    await waitFor(() => h.sockets[0].sent.some((value) => textTurn(JSON.parse(value))))
    expect(h.sockets[0].sent.filter((value) => textTurn(JSON.parse(value)))).toHaveLength(1)
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
        event_id: "sitting-1:47",
        sequence: 47,
        event_kind: "sitting_summary",
        role: "assistant",
        content: "I noticed warmth.",
      },
    ])
    expect(h.audio.at(-1)).toBe("AAAAAA==")
    expect(h.requests.filter((request) => request.url.endsWith("/sitting-1/end"))).toHaveLength(1)
  })

  test.each(["before-ACK", "after-ACK"] as const)("Stop %s waits for caption native completion before reflection", async timing => {
    const storage = new FakeStorage()
    const h = harness({storage, photoDrainTimeoutMs: 200})
    await start(h)
    completeTurn(h, "one", "answer one")
    completeTurn(h, "two", "answer two")
    await h.controller.sendImage({imageId: "ack-first", mimeType: "image/png", data: "AQID"})
    const reflectionRequests = () => h.sockets[0].sent.filter(value => textTurn(JSON.parse(value)))
    const before = [...h.audio]
    if (timing === "after-ACK") {
      saveCaption(h.sockets[0], "ack-first", "A fictional amber star.")
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "caption-ack-first"))
      expect(JSON.parse(storage.values.get(JOURNAL_KEY) || "null")?.pendingImage ?? null).toBeNull()
    }
    const stopping = h.controller.stop(true)
    try {
      if (timing === "before-ACK") saveCaption(h.sockets[0], "ack-first", "A fictional amber star.")
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "caption-ack-first"))
      expect(functionResponses(h.sockets[0]).find(response => response.id === "caption-ack-first"))
        .toMatchObject({response: {ok: true, durable: true}, scheduling: "SILENT"})
      // Let the ACK's drain continuation run before delivering the provider boundary.
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(reflectionRequests()).toEqual([])
      h.sockets[0].message({serverContent: {generationComplete: true}})
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(reflectionRequests()).toEqual([])
      h.sockets[0].message({serverContent: {
        outputTranscription: {text: "Unheard caption-turn tail."},
        modelTurn: {parts: [{inlineData: {data: "AQEBAQ=="}}]}, turnComplete: true,
      }})
      await waitFor(() => reflectionRequests().length === 1)
      expect(h.audio).toEqual(before)
      h.sockets[0].message({serverContent: {
        outputTranscription: {text: "A genuine sitting reflection."},
        modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}, turnComplete: true,
      }})
      await stopping
      const rows = h.requests.flatMap(request => request.body.events ?? [])
      expect(rows.filter(row => row.event_kind === "sitting_summary").map(row => row.content))
        .toEqual(["A genuine sitting reflection."])
      expect(rows.some(row => row.content === "Unheard caption-turn tail.")).toBe(false)
      expect(h.audio).toEqual([...before, "AAAAAA=="])
      expect(h.errors).toEqual([])
    } finally {
      h.sockets[0].message({serverContent: {turnComplete: true}})
      await stopping
    }
  })

  test("an unrelated failed photo does not suppress graceful Stop reflection", async () => {
    const storage = new FakeStorage()
    storage.values.set(JOURNAL_KEY, JSON.stringify({version: 1,
      scope: {userId: CONFIG.userId, soulId: CONFIG.soulId, deviceSessionId: CONFIG.deviceSessionId},
      resumption: null, pendingTranscripts: [],
      pendingImage: {imageId: "failed-photo", mediaRef: "mentra_media/test-phone/failed-photo.png",
        providerSent: false, captureAfterCurrent: false, generation: 1, sessionId: "old-sitting", retryRequested: true},
    }))
    const h = harness({storage})
    await start(h)
    expect(h.photoRetryChanges.at(-1)).toBe(true)
    completeTurn(h, "one", "answer one")
    completeTurn(h, "two", "answer two")
    const stopping = h.controller.stop(true)
    try {
      await waitFor(() => h.sockets[0].sent.some(value => textTurn(JSON.parse(value))))
      h.sockets[0].message({serverContent: {
        outputTranscription: {text: "A reflection despite the failed upload."},
        modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}, turnComplete: true,
      }})
      await stopping
      const rows = h.requests.flatMap(request => request.body.events ?? [])
      expect(rows.filter(row => row.event_kind === "sitting_summary").map(row => row.content))
        .toEqual(["A reflection despite the failed upload."])
      expect(JSON.parse(storage.values.get(JOURNAL_KEY)!).pendingImage).toMatchObject({
        imageId: "failed-photo", providerSent: false, retryRequested: true,
      })
      expect(h.requests.some(request => request.url.endsWith("/snapshot/replay"))).toBe(false)
      expect(h.requests.some(request => request.url.endsWith("/snapshot/finalize"))).toBe(false)
      expect(h.errors).toEqual([])
    } finally {
      h.sockets[0].message({serverContent: {turnComplete: true}})
      await stopping
    }
  })

  test.each(["before-Stop", "during-drain"] as const)("Stop retains a playing reply as interrupted with text arriving %s", async timing => {
    const h = harness({storage: new FakeStorage(), photoDrainTimeoutMs: 200})
    await start(h)
    await h.controller.sendImage({imageId: "playing-photo", mimeType: "image/png", data: "AQID"})
    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_START"}})
    h.sockets[0].message({voiceActivity: {type: "ACTIVITY_END"}})
    h.sockets[0].message({serverContent: {
      inputTranscription: {text: "A fictional question before Stop."},
      ...(timing === "before-Stop" ? {outputTranscription: {text: "A reply already heard."}} : {}),
      modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]},
    }})
    expect(h.audio).toEqual(["AAAAAA=="])
    const stopping = h.controller.stop(true)
    try {
      h.sockets[0].message({serverContent: {
        ...(timing === "during-drain" ? {outputTranscription: {text: "A reply already heard."}} : {}),
        modelTurn: {parts: [{inlineData: {data: "AQEBAQ=="}}]}, turnComplete: true,
      }})
      saveCaption(h.sockets[0], "playing-photo", "A fictional green notebook.")
      await waitFor(() => functionResponses(h.sockets[0]).some(response => response.id === "caption-playing-photo"))
      h.sockets[0].message({serverContent: {
        outputTranscription: {text: "Entirely unheard caption reasoning."}, turnComplete: true,
      }})
      await stopping
      expect(h.audio).toEqual(["AAAAAA=="])
      expect(h.errors).toEqual([])
      const rows = h.requests.flatMap(request => request.body.events ?? [])
      expect(rows.filter(row => row.role === "assistant" && row.event_kind === "transcript"))
        .toMatchObject([{content: "A reply already heard.", status: "interrupted"}])
      expect(rows.some(row => row.event_kind === "transcript_gap")).toBe(false)
      expect(rows.some(row => row.content === "Entirely unheard caption reasoning.")).toBe(false)
      expect(rows.filter(row => row.event_kind === "photo_caption").map(row => row.content))
        .toEqual(["A fictional green notebook."])
      expect(h.sockets[0].sent.some(value => textTurn(JSON.parse(value)))).toBe(false)
      expect(h.requests.filter(request => request.url.endsWith("/end"))).toHaveLength(1)
    } finally {
      h.sockets[0].message({serverContent: {turnComplete: true}})
      await stopping
    }
  })

  test("Stop drain timeout records a nonfatal gap for heard PCM without ASR or native completion", async () => {
    const storage = new FakeStorage()
    const h = harness({storage, photoDrainTimeoutMs: 5})
    await start(h)
    try {
      await h.controller.sendImage({imageId: "heard-timeout", mimeType: "image/png", data: "AQID"})
      h.sockets[0].message({voiceActivity: {type: "ACTIVITY_START"}})
      h.sockets[0].message({voiceActivity: {type: "ACTIVITY_END"}})
      h.sockets[0].message({serverContent: {
        inputTranscription: {text: "A fictional question before timeout."},
        modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]},
      }})
      expect(h.audio).toEqual(["AAAAAA=="])
      await h.controller.stop(true)
      const rows = h.requests.flatMap(request => request.body.events ?? [])
      expect(rows.filter(row => row.role === "assistant"))
        .toMatchObject([{event_kind: "transcript_gap", content: "Transcript unavailable."}])
      expect(h.persistenceErrors).toContain("Some spoken words could not be transcribed")
      expect(h.errors).toEqual([])
      expect(h.audio).toEqual(["AAAAAA=="])
      expect(JSON.parse(storage.values.get(JOURNAL_KEY)!).pendingImage)
        .toMatchObject({imageId: "heard-timeout", retryRequested: true})
      expect(h.sockets[0].sent.some(value => textTurn(JSON.parse(value)))).toBe(false)
      expect(h.requests.filter(request => request.url.endsWith("/end"))).toHaveLength(1)
    } finally {
      await h.controller.stop()
    }
  })

  test("graceful Stop may speak NO_SUMMARY without persisting it", async () => {
    const h = harness()
    await start(h)
    completeTurn(h, "one", "answer one")
    completeTurn(h, "two", "answer two")
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/transcripts/append")))

    const stopping = h.controller.stop(true)
    await waitFor(() => h.sockets[0].sent.some((value) => textTurn(JSON.parse(value))))
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

  test.each([false, true])("late input during reflection preserves orphan speech and summary (co-packet=%s)", async coPacket => {
    const h = harness({storage: new FakeStorage()})
    await start(h)
    completeTurn(h, "one", "answer one")
    completeTurn(h, "two", "answer two")
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/transcripts/append")))

    const stopping = h.controller.stop(true)
    await waitFor(() => h.sockets[0].sent.some((value) => textTurn(JSON.parse(value))))
    const audioBefore = [...h.audio]
    if (!coPacket) {
      h.sockets[0].message({serverContent: {inputTranscription: {text: "Delayed orphan "}}})
      h.sockets[0].message({serverContent: {inputTranscription: {text: "words."}}})
    }
    expect(h.errors).toEqual([])
    expect(h.audio).toEqual(audioBefore)
    expect(h.requests.some(request => request.url.endsWith("/end"))).toBe(false)
    h.sockets[0].message({serverContent: {
      ...(coPacket ? {inputTranscription: {text: "Delayed orphan words."}} : {}),
      modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]},
      outputTranscription: {text: "I noticed a quiet sense of connection."}, turnComplete: true,
    }})
    await stopping

    const events = h.requests.flatMap(request => request.body.events ?? [])
    expect(events.slice(-2)).toEqual([
      {event_id: "sitting-1:45", sequence: 45, event_kind: "transcript", role: "user", status: "complete",
        content: "[Turn timing uncertain; combined speech, text retained in received order.]\nDelayed orphan words."},
      {event_id: "sitting-1:46", sequence: 46, event_kind: "sitting_summary", role: "assistant",
        content: "I noticed a quiet sense of connection."},
    ])
    expect(events.filter(event => event.role === "assistant" && event.event_kind === "transcript")
      .map(event => event.content)).toEqual(["answer one", "answer two"])
    expect(h.audio).toEqual([...audioBefore, "AAAAAA=="])
    expect(h.errors).toEqual([])
    expect(h.requests.filter((request) => request.url.endsWith("/end"))).toHaveLength(1)
  })

  test("socket close during reflection discards partial private reflection", async () => {
    const h = harness()
    await start(h)
    completeTurn(h, "one", "answer one")
    completeTurn(h, "two", "answer two")
    await waitFor(() => h.requests.some((request) => request.url.endsWith("/transcripts/append")))

    const stopping = h.controller.stop(true)
    await waitFor(() => h.sockets[0].sent.some((value) => textTurn(JSON.parse(value))))
    h.sockets[0].message({serverContent: {outputTranscription: {text: "private partial"}}})
    h.sockets[0].close()
    await stopping

    const events = h.requests
      .filter((request) => request.url.endsWith("/transcripts/append"))
      .flatMap((request) => request.body.events)
    expect(events.some((event: any) => event.content === "private partial")).toBe(false)
    expect(h.sockets).toHaveLength(1)
  })

  test("audio during a deferred socket close leaves recovery in charge", async () => {
    const h = harness()
    await start(h)
    h.controller.sendAudio("AAAA", "phone")
    h.sockets[0].message({serverContent: {inputTranscription: {text: "before reconnect"}}})
    const socket = h.sockets[0]
    const close = socket.close.bind(socket)
    socket.close = () => {}
    socket.error()
    expect(() => h.controller.sendAudio("AAAA", "glasses")).not.toThrow()
    expect(socket.sent).toHaveLength(2)
    socket.readyState = 2
    expect(() => h.controller.sendAudio("AAAA", "glasses")).not.toThrow()
    close()
    await waitFor(() => h.sockets.length === 2)
    h.sockets[1].open()
    h.sockets[1].message({setupComplete: {}})
    await waitFor(() => h.reconnecting.at(-1) === false)
    h.controller.sendAudio("AAAA")
    expect(h.sockets[1].sent).toHaveLength(2)
    expect(h.errors).toEqual([])
    completeTurn(h)
    await h.controller.stop()
    const events = h.requests.filter(request => request.url.endsWith("/transcripts/append"))
      .flatMap(request => request.body.events)
    expect(events.map((event: any) => event.mic_source)).toEqual(["phone", undefined, undefined])
  })

  test("stalled response bodies time out without losing transcript retries", async () => {
    const original = globalThis.setTimeout
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, ms?: number, ...args: any[]) =>
      original(callback, ms === 10_000 || ms === 30_000 ? 10 : ms, ...args)) as typeof setTimeout)
    try {
      for (const bodyTransportFailure of [false, true]) {
        const starting = harness({stalledBodyPath: "/session/start", bodyTransportFailure})
        await expect(starting.controller.start()).rejects.toThrow("Timed out")
        expect(starting.requests.some(request => request.url.endsWith("/end"))).toBe(false)
        const storage = new FakeStorage()
        const h = harness({stalledBodyPath: "/transcripts/append", storage, bodyTransportFailure})
        await start(h)
        completeTurn(h, "fictional unsynced words", "fictional reply")
        await waitFor(() => h.persistenceErrors.includes("Transcript sync failed; retrying"))
        expect(h.errors).toEqual([])
        await h.controller.stop()
        expect([...storage.values.values()].join(" ")).toContain("fictional unsynced words")
        expect(h.requests.some(request => request.url.endsWith("/end"))).toBe(true)

        const recalling = harness({stalledBodyPath: "/recall", bodyTransportFailure})
        await start(recalling)
        recalling.sockets[0].message({toolCall: {functionCalls: [
          {id: "stalled-recall", name: "recall_memory", args: {query: "beacon"}},
        ]}})
        await waitFor(() => recalling.persistenceErrors.includes("Memory recall unavailable; voice is continuing"))
        expect(recalling.errors).toEqual([])
        await recalling.controller.stop()

        let errorReported!: () => void
        const failed = new Promise<void>(resolve => { errorReported = resolve })
        const renewing = harness({stalledBodyPath: "/token", setupTimeoutMs: 10, bodyTransportFailure,
          onError: errorReported})
        await start(renewing)
        renewing.sockets[0].error()
        await failed
        expect(renewing.requests.filter(request => request.url.endsWith("/token"))).toHaveLength(6)
        expect(renewing.errors).toHaveLength(1)
        await renewing.controller.stop()

        const heartbeat = harness({stalledBodyPath: "/heartbeat", heartbeatMs: 5, leaseSeconds: 0.03, bodyTransportFailure})
        await start(heartbeat)
        await new Promise(resolve => original(resolve, 60))
        expect(heartbeat.errors).toEqual(["OpenAlma heartbeat lease expired"])
        await heartbeat.controller.stop()
      }
    } finally {
      timer.mockRestore()
    }
  })

  test("resumes with the latest private handle and resets only after a completed turn", async () => {
    const h = harness()
    await start(h)
    h.sockets[0].message({serverContent: {inputTranscription: {text: "before drop"}}})
    h.sockets[0].message({serverContent: {outputTranscription: {text: "partial answer"}, modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}}})
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

  test("can reconnect repeatedly while silent after successful setup", async () => {
    for (const resumable of [false, true]) {
      const h = harness()
      await start(h)
      if (resumable) h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
      try {
        for (let index = 0; index < 2; index++) {
          h.sockets[index].close()
          await waitFor(() => h.sockets.length === index + 2 || h.errors.length > 0)
          expect(h.errors).toEqual([])
          h.sockets[index + 1].open()
          h.sockets[index + 1].message({setupComplete: {}})
          await waitFor(() => h.reconnecting.length === (index + 1) * 2)
        }
        expect(h.sockets).toHaveLength(3)
      } finally {
        await h.controller.stop()
      }
    }
  })

  test("cold reconnect is allowed only before the first completed provider turn", async () => {
    const idle = harness()
    await start(idle)
    idle.sockets[0].close()
    await waitFor(() => idle.sockets.length === 2)
    idle.sockets[1].open()
    expect(JSON.parse(idle.sockets[1].sent[0])).toEqual({setup: {sessionResumption: {}}})
    idle.sockets[1].message({setupComplete: {}})
    await waitFor(() => idle.reconnecting.at(-1) === false)
    expect(idle.errors).toEqual([])
    await idle.controller.stop()

    const active = harness()
    await start(active)
    completeTurn(active)
    active.sockets[0].close()
    await waitFor(() => active.errors.length === 1)
    expect(active.sockets).toHaveLength(1)
    expect(active.errors).toEqual(["Gemini connection closed"])
    await active.controller.stop()
  })

  test("cold reconnect replays a photo sent during an unfinished turn", async () => {
    const h = harness({storage: new FakeStorage()})
    await start(h)
    h.sockets[0].message({serverContent: {inputTranscription: {text: "unfinished"}}})
    await h.controller.sendImage({imageId: "image-cold", mimeType: "image/png", data: "AQID"})
    h.sockets[0].close()
    await waitFor(() => h.sockets.length === 2)
    h.sockets[1].open()
    h.sockets[1].message({setupComplete: {}})
    await waitFor(() => h.sockets[1].sent.some((value) => photoInput(JSON.parse(value))))

    expect(h.sockets[1].sent.filter((value) => photoInput(JSON.parse(value)))).toHaveLength(1)
    saveCaption(h.sockets[1], "image-cold", "The photo shows a fictional blue square.")
    await waitFor(() => h.requests.some(request => request.url.endsWith("/snapshot/finalize")))
    const rows = h.requests.filter(request => request.url.endsWith("/transcripts/append"))
      .flatMap(request => request.body.events)
    expect(rows.map(event => [event.sequence, event.event_kind, event.status])).toEqual([
      [41, "transcript", "interrupted"], [42, "image", undefined], [43, "photo_caption", undefined],
    ])
    expect(h.requests.find(request => request.url.endsWith("/snapshot/finalize"))?.body.caption_event_id).toBe("sitting-1:photo:image-cold")
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
    await waitFor(() => h.sockets.length === 2)
    h.sockets[1].open()
    expect(JSON.parse(h.sockets[1].sent[0])).toEqual({setup: {sessionResumption: {}}})
    h.sockets[1].message({setupComplete: {}})
    await waitFor(() => h.reconnecting.at(-1) === false)
    expect(h.errors).toEqual([])
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
      serverContent: {outputTranscription: {text: "finished"}, modelTurn: {parts: [{inlineData: {data: "AAAAAA=="}}]}, turnComplete: true},
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

  test.each(["close", "goAway"] as const)("%s replays an interrupted image on the replacement", async cause => {
      const h = harness({storage: new FakeStorage()})
      await start(h)
      h.sockets[0].message({sessionResumptionUpdate: {resumable: true, newHandle: "private-handle"}})
      await h.controller.sendImage({imageId: `image-${cause}`, mimeType: "image/png", data: "AQID"})

      if (cause === "close") h.sockets[0].close()
      else h.sockets[0].message({goAway: {timeLeft: "0.1s"}})
      await waitFor(() => h.sockets.length === 2)
      h.sockets[1].open()
      h.sockets[1].message({setupComplete: {}})
      await waitFor(() => h.sockets[1].sent.some((value) => photoInput(JSON.parse(value))))
      saveCaption(h.sockets[1], `image-${cause}`, "The photo shows a fictional blue square.")
      await waitFor(() => h.requests.some((request) => request.url.endsWith("/snapshot/finalize")))

      expect(h.errors).toEqual([])
      await h.controller.stop()
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

  test.each([["audio", false], ["audio", true], ["content", true]] as const)(
    "malformed known %s fails before executing a co-packet write (write=%s)", async (malformed, withWrite) => {
    const h = harness()
    await start(h)
    try {
      h.sockets[0].message({
        serverContent: malformed === "audio" ? {modelTurn: {parts: [{inlineData: {data: "bad"}}]}} : null,
        ...(withWrite ? {toolCall: {functionCalls: [
          {id: "malformed-packet-write", name: "save_working_thought", args: {thought: "A fictional beacon."}},
        ]}} : {}),
      })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(h.requests.some(request => request.url.endsWith("/working-thought"))).toBe(false)
      expect(functionResponses(h.sockets[0])).toEqual([])
      expect(h.errors).toEqual([malformed === "audio"
        ? "Gemini returned malformed audio" : "Gemini returned malformed server content"])
    } finally {
      await h.controller.stop()
    }
  })

  test("same-packet tool cancellation prevents executing the cancelled write", async () => {
    const h = harness()
    await start(h)
    try {
      h.sockets[0].message({
        toolCall: {functionCalls: [
          {id: "cancel-before-execution", name: "save_working_thought", args: {thought: "A fictional beacon."}},
        ]},
        toolCallCancellation: {ids: ["cancel-before-execution"]},
        serverContent: {turnComplete: true},
      })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(h.requests.some(request => request.url.endsWith("/working-thought"))).toBe(false)
      expect(functionResponses(h.sockets[0])).toEqual([])
      expect(h.errors).toEqual([])
      expect(h.persistenceErrors.some(message => message?.includes("may have saved"))).toBe(false)
    } finally {
      await h.controller.stop()
    }
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

  test("an old heartbeat cannot fail or pause a replacement sitting", async () => {
    for (const options of [
      {heartbeatStatus: 404},
      {heartbeatThrows: true},
      {heartbeatBody: {ok: true, pause_reason: "Old sitting pause"}},
    ]) {
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const h = harness({heartbeatMs: 60_000, heartbeatGate: gate, ...options})
      await start(h)
      const pending = Reflect.get(h.controller, "heartbeat").call(h.controller)
      await waitFor(() => h.requests.some(request => request.url.endsWith("/heartbeat")))
      await h.controller.stop()
      const starting = h.controller.start()
      await waitFor(() => h.sockets.length === 2)
      h.sockets[1].open()
      h.sockets[1].message({setupComplete: {}})
      await starting
      release()
      await pending
      expect(h.controller.activityPauseReason).toBeNull()
      expect(h.errors).toEqual([])
      expect(h.sockets[1].readyState).toBe(1)
      await h.controller.stop()
    }
  })

  test("heartbeat clears a background image-memory failure without hiding failed speech sync", async () => {
    const message = "Photo memory processing failed; the original remains saved."
    const heartbeatBody: {ok: boolean; background_error?: string} = {ok: true, background_error: message}
    const h = harness({heartbeatMs: 60_000, heartbeatBody, appendStatuses: [503]})
    await start(h)
    const heartbeat = () => Reflect.get(h.controller, "heartbeat").call(h.controller)
    await heartbeat()
    expect(h.persistenceErrors.at(-1)).toBe(message)
    delete heartbeatBody.background_error
    await heartbeat()
    expect(h.persistenceErrors.at(-1)).toBeNull()
    heartbeatBody.background_error = message
    await heartbeat()
    completeTurn(h)
    await waitFor(() => h.persistenceErrors.at(-1) === "Transcript sync failed; retrying")
    delete heartbeatBody.background_error
    await heartbeat()
    expect(h.persistenceErrors.at(-1)).toBe("Transcript sync failed; retrying")
    completeTurn(h)
    await waitFor(() => h.persistenceErrors.at(-1) === null)
    await h.controller.stop()
  })

  test("pause blocks new input without cutting output and heartbeat recovery unblocks it", async () => {
    const heartbeatBody = {ok: true, pause_reason: "Failed Memorize" as string | null}
    const h = harness({heartbeatMs: 5, heartbeatBody})
    await start(h, "manual")
    await waitFor(() => Boolean(h.controller.activityPauseReason))
    const socket = h.sockets[0]
    const sent = socket.sent.length
    h.controller.sendAudio("AQID")
    expect(socket.sent.length).toBe(sent)
    expect(() => h.controller.sendActivity(["AQID"])).toThrow("Retry in OpenAlma launcher")
    socket.message({serverContent: {modelTurn: {parts: [{inlineData: {mimeType: "audio/pcm;rate=24000", data: "AQEBAQ=="}}]}}})
    await waitFor(() => h.audio.includes("AQEBAQ=="))
    expect(socket.readyState).toBe(1)
    expect(h.errors).toEqual([])
    heartbeatBody.pause_reason = null
    await waitFor(() => h.controller.activityPauseReason === null)
    h.controller.sendActivity(["AQID"])
    expect(socket.sent.length).toBeGreaterThan(sent)
    await h.controller.stop()
  })

  test("paused Start reports launcher recovery instead of a generic HTTP failure", async () => {
    const h = harness({startStatus: 409, startBody: {detail: {
      code: "soul_paused", message: "Test Soul is paused. Retry in OpenAlma launcher.",
    }}})
    await expect(h.controller.start()).rejects.toThrow("Retry in OpenAlma launcher")
    expect(h.sockets).toHaveLength(0)
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
