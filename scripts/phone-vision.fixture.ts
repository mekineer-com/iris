import {act, createElement} from "react"
import {createRoot} from "react-dom/client"
import {usePhoneVision} from "../src/ui/hooks/usePhoneVision"
import SessionPage from "../src/ui/pages/SessionPage"
import {VISION_SETTINGS, type SessionSnapshot} from "../src/shared/types"

declare global {interface Window {visionTest: Promise<unknown>}}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const assert = (ok: unknown, label: string) => {if (!ok) throw new Error(label)}
const wait = async (predicate: () => boolean) => {
  for (let n = 0; n < 200 && !predicate(); n++) await act(async () => {await new Promise(resolve => setTimeout(resolve, 10))})
  assert(predicate(), "fixture wait expired")
}
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(yes => resolve = yes); return {resolve, promise}}
const tickers = new Map<number, () => void>()
const nativeInterval = window.setInterval.bind(window), nativeClear = window.clearInterval.bind(window)
let timerId = 100000
window.setInterval = ((fn: () => void, ms: number) => {
  if (ms !== VISION_SETTINGS.capturePeriodMs) return nativeInterval(fn, ms)
  const id = timerId++; tickers.set(id, fn); return id
}) as typeof window.setInterval
window.clearInterval = id => {if (id === undefined || !tickers.delete(id)) nativeClear(id)}
const calls: Array<{channel: string; payload: any}> = []
const devices: Array<{canvas: HTMLCanvasElement; stream: MediaStream}> = []
let acquisition: ReturnType<typeof deferred<MediaStream>> | null = null
let reservation: ReturnType<typeof deferred<any>> | null = null
let intakeReply: ReturnType<typeof deferred<any>> | null = null
let frameError: Error | null = null
let outcome = {retained: true, delivery: "sent"}
let sequence = 0
let lastReference: any
let readFrames: any[] = []
const signals: AbortSignal[] = []
const listeners = new Map<string, (payload: any) => void>()
const warnings: string[] = []
const warn = console.warn
console.warn = (...args) => {warnings.push(args.join(" ")); warn(...args)}
function device() {
  const canvas = document.createElement("canvas"); canvas.width = 1080; canvas.height = 1920
  canvas.getContext("2d")!.fillStyle = "rgb(20,160,40)"; canvas.getContext("2d")!.fillRect(0, 0, canvas.width, canvas.height)
  const stream = canvas.captureStream(0)
  const value = {canvas, stream}; devices.push(value); return value
}
Object.defineProperty(navigator.mediaDevices, "getUserMedia", {configurable: true, value: async (options: any) => {
  assert(options.audio === false, "camera requested audio")
  return acquisition ? acquisition.promise : device().stream
}})
;(globalThis as any).mentra = {
  on(channel: string, callback: (payload: any) => void) {listeners.set(channel, callback); return () => listeners.delete(channel)},
  send(channel: string, payload: any) {calls.push({channel, payload})},
  request(channel: string, payload: any, options: {signal: AbortSignal}) {
  calls.push({channel, payload}); signals.push(options.signal)
  let result: Promise<any>
  if (channel === "openalma:reserve-image") {
    const value = {startGeneration: payload.startGeneration, imageId: `${payload.time.timestamp}-${++sequence + 1}`, reservationSequence: sequence}
    lastReference = value
    result = reservation ? reservation.promise : Promise.resolve(value)
  } else if (channel === "openalma:frame") {
    result = frameError ? Promise.reject(frameError)
      : intakeReply ? intakeReply.promise : Promise.resolve(outcome)
  } else if (channel === "openalma:frames") result = Promise.resolve({frames: readFrames})
  else result = Promise.resolve()
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {reject(new DOMException("aborted", "AbortError")); return}
    const abort = () => reject(new DOMException("aborted", "AbortError"))
    options.signal.addEventListener("abort", abort, {once: true})
    result.then(resolve, reject).finally(() => options.signal.removeEventListener("abort", abort))
  })
}}
let snapshot = {callMode: "video", startGeneration: 1, cameraEnabled: true,
  frameDeliveryOpen: true, connection: "listening", catchUpRender: null} as SessionSnapshot
let foreground = true
let control!: ReturnType<typeof usePhoneVision>
function Fixture() {control = usePhoneVision(snapshot, foreground); return createElement("video", {ref: control.videoRef})}
const container = document.createElement("div"); document.body.append(container)
const root = createRoot(container)
const render = async () => {await act(async () => {root.render(createElement(Fixture))})}
const tick = async () => {await act(async () => {for (const fn of [...tickers.values()]) fn()})}
const count = (channel: string) => calls.filter(call => call.channel === channel).length
const paint = async (color: string) => {
  const source = devices[devices.length - 1]!
  const video = control.videoRef.current!
  await new Promise<void>(resolve => {
    video.requestVideoFrameCallback(() => resolve())
    source.canvas.getContext("2d")!.fillStyle = color
    source.canvas.getContext("2d")!.fillRect(0, 0, source.canvas.width, source.canvas.height)
    ;(source.stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack).requestFrame()
  })
}
async function center(data: string | Blob) {
  const blob = typeof data === "string" ? new Blob([Uint8Array.from(atob(data), char => char.charCodeAt(0))], {type: "image/jpeg"}) : data
  const image = await createImageBitmap(blob), canvas = document.createElement("canvas")
  canvas.width = image.width; canvas.height = image.height; canvas.getContext("2d")!.drawImage(image, 0, 0)
  const result = [...canvas.getContext("2d")!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data]
  const size = [image.width, image.height]; image.close(); return {pixel: result, size}
}
window.visionTest = (async () => {
  const checks: string[] = []
  try {
    await render(); await wait(() => count("openalma:frame") === 1)
    assert(control.ready && devices.length === 1, "initial camera/submit failed")
    const firstFrame = calls.find(call => call.channel === "openalma:frame")!.payload
    assert((await center(firstFrame.data)).size.join() === "432,768", "portrait cap failed")
    for (const connection of ["speaking", "reconnecting", "listening"] as const) {
      snapshot = {...snapshot, connection, frameDeliveryOpen: connection !== "reconnecting"}; await render(); await tick()
    }
    assert(devices.length === 1 && devices[0].stream.getTracks()[0].readyState === "live", "snapshot/reconnect churned tracks")
    checks.push("real React effect acquires once across snapshots and reconnect")

    await paint("rgb(200,20,20)"); reservation = deferred<any>(); const before = count("openalma:reserve-image")
    await tick(); await wait(() => count("openalma:reserve-image") === before + 1); await tick()
    assert(count("openalma:reserve-image") === before + 1, "sampling overlapped a held reservation")
    await paint("rgb(20,20,200)"); const still = await control.takePhoto()
    reservation.resolve(lastReference)
    reservation = null; const framesBefore = count("openalma:frame"); await wait(() => count("openalma:frame") > framesBefore)
    const frame = calls.filter(call => call.channel === "openalma:frame").slice(-1)[0]!.payload
    const original = await center(frame.data), model = await center(frame.modelData), photo = await center(still.file)
    assert(original.pixel[0] > 150 && model.pixel[0] > 150 && photo.pixel[2] > 150, "still overwrote reserved passive pixels")
    checks.push("serial reservation and separate Video still preserve original/model binding")

    await paint("rgb(180,140,30)")
    frameError = Object.assign(new Error("reply lost"), {name: "MentraRpcTimeoutError"}); await tick()
    await wait(() => warnings.some(warning => warning.includes("reply lost")))
    assert(control.error === null, "best-effort frame timeout flashed an alert")
    const failed = count("openalma:frame"); frameError = null
    await tick(); await wait(() => count("openalma:frame") === failed + 1)
    await wait(() => control.error === null); const confirmed = count("openalma:reserve-image"); await tick()
    assert(count("openalma:reserve-image") === confirmed, "unknown advanced baseline or confirmed repeat was not filtered")
    checks.push("uncertain intake is not success; confirmed exact repeats are filtered")

    await paint("rgb(110,70,130)"); frameError = new Error("Fictional frame validation failure"); await tick()
    await wait(() => !!control.error)
    assert(control.error!.includes("Fictional frame validation failure"), "non-timeout failure lost its alert")
    frameError = null; await tick(); await wait(() => control.error === null)
    checks.push("frame timeouts log quietly while genuine frame errors remain visible")

    for (const [color, result] of [
      ["rgb(30,100,180)", {retained: true, delivery: "not-sent"}],
      ["rgb(100,180,30)", {retained: false, delivery: "sent"}],
      ["rgb(180,30,100)", {retained: false, delivery: "not-sent"}],
    ] as const) {
      outcome = result
      await paint(color)
      const before = count("openalma:frame")
      await tick(); await wait(() => count("openalma:frame") === before + 1)
      await tick()
      assert(count("openalma:frame") === before + (result.retained || result.delivery === "sent" ? 1 : 2),
        "frame baseline did not follow retained-or-sent acknowledgment")
    }
    outcome = {retained: true, delivery: "sent"}
    checks.push("retained-only and sent-only advance baseline; rejected frames do not")

    await paint("rgb(40,130,80)"); intakeReply = deferred<any>()
    const oldContext = count("openalma:frame")
    await tick(); await wait(() => count("openalma:frame") === oldContext + 1)
    snapshot = {...snapshot, connection: "reconnecting", frameDeliveryOpen: false}; await render()
    snapshot = {...snapshot, connection: "listening", frameDeliveryOpen: true}; await render()
    intakeReply.resolve({retained: true, delivery: "sent"}); intakeReply = null
    await act(async () => {await new Promise(resolve => setTimeout(resolve, 0))})
    await tick()
    assert(count("openalma:frame") === oldContext + 2, "old delivery acknowledgment consumed the reconnected context's fresh-view refresh")
    checks.push("late acknowledgment from an old context cannot consume a new refresh")

    reservation = deferred<any>(); await paint("rgb(150,20,180)"); await tick()
    const head = firstFrame.imageId
    readFrames = [{...firstFrame, time: {receivedAt: 1000}}]
    snapshot = {...snapshot, catchUpRender: {renderId: "render-one", imageIds: [head]}}; await render()
    await wait(() => count("openalma:catch-up-rendered") === 1)
    const returned = calls.find(call => call.channel === "openalma:catch-up-rendered")!.payload
    assert((await center(returned.data)).size.join() === "768,768", "render result invalid")
    await render(); assert(count("openalma:frames") === 1, "unrelated snapshot restarted rendering")
    checks.push("collage rendering is independent of held capture and keyed by attempt")

    const decode = HTMLImageElement.prototype.decode; const gate = deferred<void>(); let held = false
    HTMLImageElement.prototype.decode = async function() {await decode.call(this); if (!held) {held = true; await gate.promise}}
    snapshot = {...snapshot, catchUpRender: {renderId: "stale", imageIds: [head]}}; await render(); await wait(() => held)
    snapshot = {...snapshot, catchUpRender: {renderId: "new", imageIds: [head]}}; await render()
    await wait(() => calls.some(call => call.channel === "openalma:catch-up-rendered" && call.payload.renderId === "new"))
    gate.resolve(); await act(async () => {await Promise.resolve()}); HTMLImageElement.prototype.decode = decode
    assert(!calls.some(call => call.channel === "openalma:catch-up-rendered" && call.payload.renderId === "stale"), "stale decode submitted")
    checks.push("replaced render cancels stale decoding without a failure reply")

    const stopGate = deferred<void>(); let stopHeld = false
    HTMLImageElement.prototype.decode = async function() {await decode.call(this); stopHeld = true; await stopGate.promise}
    snapshot = {...snapshot, catchUpRender: {renderId: "stopped", imageIds: [head]}}; await render(); await wait(() => stopHeld)
    await act(async () => {
      control.stop()
      stopGate.resolve()
      // The imperative Stop must invalidate work before an effect cleanup can run.
      await new Promise(resolve => setTimeout(resolve, 0))
      assert(!calls.some(call => call.channel === "openalma:catch-up-rendered" && call.payload.renderId === "stopped"),
        "Stop allowed the decoded collage to submit")
    })
    HTMLImageElement.prototype.decode = decode
    assert(devices[0].stream.getTracks().every(track => track.readyState === "ended"), "Stop did not release tracks synchronously")
    checks.push("imperative Stop rejects a held decode before React cleanup")

    foreground = false; await render()
    const heldBefore = count("openalma:reserve-image")
    reservation = deferred<any>(); foreground = true; await render()
    await wait(() => count("openalma:reserve-image") > heldBefore)
    const heldSignal = signals[signals.length - 1]!, framesAtHide = count("openalma:frame")
    assert(!heldSignal.aborted, "new held reservation was already aborted")
    foreground = false; await render()
    assert(heldSignal.aborted, "hide did not abort its pending reservation")
    reservation.resolve(lastReference)
    await act(async () => {await Promise.resolve()})
    assert(count("openalma:frame") === framesAtHide, "hidden reservation submitted a frame after cancellation")
    reservation = null; acquisition = deferred<MediaStream>(); foreground = true; await render()
    const late = device(); control.stop(); foreground = false; await render(); acquisition.resolve(late.stream)
    await act(async () => {await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 20))})
    assert(late.stream.getTracks().every(track => track.readyState === "ended"), "late permission stream leaked")
    checks.push("hide/unmount and late permission release native tracks and cancel work")

    acquisition = null
    const oldReservation = deferred<any>(); reservation = oldReservation
    const beforeOld = count("openalma:reserve-image"); foreground = true; await render()
    await wait(() => count("openalma:reserve-image") > beforeOld)
    const oldReference = lastReference
    const toBlob = HTMLCanvasElement.prototype.toBlob; let finishStill: (() => void) | undefined
    HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
      toBlob.call(this, blob => {finishStill = () => callback(blob)}, type, quality)
    }
    const oldStill = control.takePhoto().then(() => "accepted", error => String(error))
    await wait(() => !!finishStill)
    HTMLCanvasElement.prototype.toBlob = toBlob
    reservation = null; const framesAtRestart = count("openalma:frame")
    snapshot = {...snapshot, startGeneration: 2}; await render()
    await wait(() => count("openalma:frame") > framesAtRestart)
    oldReservation.resolve(oldReference); finishStill!()
    assert((await oldStill).includes("inactive camera"), "old still was accepted into the replacement sitting")
    await act(async () => {await Promise.resolve()})
    assert(calls.filter(call => call.channel === "openalma:frame").slice(framesAtRestart)
      .every(call => call.payload.startGeneration === 2), "old frame submitted into the replacement sitting")
    checks.push("replacement sitting rejects held frame reservations and still encodes")

    foreground = false; await render()
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {configurable: true, value: async () => {
      throw new DOMException("Camera permission denied", "NotAllowedError")
    }})
    foreground = true; await render(); await wait(() => !!control.error)
    snapshot = {...snapshot, callMode: "audio"}; await render()
    assert(control.error === null, "camera failure leaked into Audio call")
    checks.push("camera permission errors clear when leaving Video")

    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {configurable: true, value: async () => device().stream})
    let hidden = false
    Object.defineProperty(document, "hidden", {configurable: true, get: () => hidden})
    await act(async () => {root.render(createElement(SessionPage))})
    const beforePage = devices.length
    const pageSnapshot = {...snapshot, callMode: "video", configured: true,
      soulId: "Quill", souls: ["Quill"], soulConfirmed: true, soulLoading: false, modelChoice: null,
      model: null, configuredModel: null, modelSaving: false, maxMemorizedPhotos: 1,
      pendingPhotoIds: [], photoCaptions: [], photoRetryPending: false, catchUpRender: null}
    await act(async () => {listeners.get("openalma:update")!(pageSnapshot)})
    await wait(() => devices.length === beforePage + 1 && container.querySelector("video")!.readyState >= 2)
    const active = devices[devices.length - 1]!, beforeHide = devices.length
    await act(async () => {
      hidden = true; document.dispatchEvent(new Event("visibilitychange"))
      assert(active.stream.getTracks().every(track => track.readyState === "ended"), "page hide did not release tracks synchronously")
      hidden = false; document.dispatchEvent(new Event("visibilitychange"))
    })
    await wait(() => devices.length === beforeHide + 1 && container.querySelector("video")!.readyState >= 2)
    assert(devices[devices.length - 1]!.stream.getTracks().every(track => track.readyState === "live"), "batched show left the camera off")
    checks.push("real SessionPage recovers from hide/show in a single React batch")
    const allowances = []
    for (const n of [1, 2, 3, 4, 5]) {
      await act(async () => {listeners.get("openalma:update")!({...pageSnapshot, connection: "idle", maxMemorizedPhotos: n})})
      allowances.push({n, label: container.querySelector("output")!.textContent})
    }
    return {ok: true, checks, allowances, frames: calls.filter(call => call.channel === "openalma:frame").map(call => call.payload)}
  } catch (error) {return {ok: false, error: String(error), stack: (error as Error).stack, checks}}
  finally {console.warn = warn; await act(async () => root.unmount()); for (const item of devices) item.stream.getTracks().forEach(track => track.stop())}
})()
