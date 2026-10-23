import {expect, mock, test} from "bun:test"
import {PhoneCamera, cameraShouldRun, type PhoneCameraState} from "./phoneCamera"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no})
  return {promise, resolve, reject}
}

class Track extends EventTarget {
  readyState = "live"
  stop = mock(() => {this.readyState = "ended"})
}

function media() {
  const track = new Track()
  const stream = {getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => []}
  return {track, stream: stream as unknown as MediaStream}
}

function harness(acquire?: () => Promise<MediaStream>) {
  const active = media()
  const video = {srcObject: null as unknown, videoWidth: 480, videoHeight: 640,
    readyState: 2, muted: false, playsInline: false, play: mock(async () => {})}
  const contexts = [0, 1].map(() => ({
    drawImage: mock(() => {}),
    getImageData: mock(() => ({data: new Uint8ClampedArray([1, 2, 3, 0, 4, 5, 6, 255])})),
  }))
  const canvases = contexts.map(context => ({width: 0, height: 0,
    getContext: () => context,
    toDataURL: mock(() => "data:image/jpeg;base64,/9j/fixture"),
  }))
  const page = Object.assign(new EventTarget(), {hidden: false,
    createElement: mock(() => canvases[page.createElement.mock.calls.length - 1])})
  const browser = new EventTarget()
  const getUserMedia = mock(acquire ?? (async () => active.stream))
  const camera = new PhoneCamera(video as unknown as HTMLVideoElement, {getUserMedia},
    page as unknown as Document, browser as unknown as Window)
  return {camera, active, video, page, browser, getUserMedia, canvases, contexts}
}

const options = {maxWidth: 320, jpegQuality: 0.7, comparisonWidth: 2, comparisonHeight: 1}

test("requests rear video without a second microphone and enables inline playback", async () => {
  const h = harness()
  expect(await h.camera.start()).toBe(true)
  expect(h.getUserMedia).toHaveBeenCalledWith({audio: false, video: {facingMode: {ideal: "environment"}}})
  expect(h.video.srcObject).toBe(h.active.stream)
  expect(h.video.muted && h.video.playsInline).toBe(true)
  h.camera.dispose()
})

test("samples one portrait frame, strips the data URL and separates RGB from alpha", async () => {
  const h = harness()
  await h.camera.start()
  const before = Date.now()
  const sample = h.camera.sample(options)!
  expect(sample).toMatchObject({mimeType: "image/jpeg", data: "/9j/fixture", width: 320, height: 427,
    comparison: {width: 2, height: 1, data: new Uint8Array([1, 2, 3, 4, 5, 6])}})
  expect(sample.receivedAt).toBeGreaterThanOrEqual(before)
  expect(h.contexts[1].drawImage.mock.calls[0][0]).toBe(h.canvases[0])
  expect(h.canvases[0].toDataURL).toHaveBeenCalledWith("image/jpeg", 0.7)
  h.camera.dispose()
})

test("does not upscale the original or sample before decoded pixels exist", async () => {
  const h = harness()
  expect(h.camera.sample(options)).toBeNull()
  await h.camera.start()
  h.video.readyState = 1
  expect(h.camera.sample(options)).toBeNull()
  h.video.readyState = 2
  h.video.videoWidth = 100
  h.video.videoHeight = 50
  expect(h.camera.sample(options)).toMatchObject({width: 100, height: 50})
  h.camera.dispose()
  expect(h.camera.sample(options)).toBeNull()
})

test("permission refusal leaves no active camera and reports the error", async () => {
  const h = harness(async () => {throw new Error("Permission denied")})
  await expect(h.camera.start()).rejects.toThrow("Permission denied")
  expect(h.camera.running).toBe(false)
  h.camera.dispose()
})

test.each(["stop", "hide", "pagehide", "dispose"])("%s during permission wait closes the late stream", async action => {
  const pending = deferred<MediaStream>()
  const h = harness(() => pending.promise)
  const starting = h.camera.start()
  if (action === "hide") {h.page.hidden = true; h.page.dispatchEvent(new Event("visibilitychange"))}
  else if (action === "pagehide") h.browser.dispatchEvent(new Event("pagehide"))
  else if (action === "dispose") h.camera.dispose()
  else h.camera.stop()
  pending.resolve(h.active.stream)
  expect(await starting).toBe(false)
  expect(h.active.track.stop).toHaveBeenCalledTimes(1)
  expect(h.video.srcObject).toBeNull()
  expect(h.camera.running).toBe(false)
  h.camera.dispose()
})

test("overlapping starts close the late original without stopping its replacement", async () => {
  const first = deferred<MediaStream>(), second = deferred<MediaStream>()
  let calls = 0
  const h = harness(() => ++calls === 1 ? first.promise : second.promise)
  const old = h.camera.start(), replacement = h.camera.start()
  const next = media()
  second.resolve(next.stream)
  expect(await replacement).toBe(true)
  first.resolve(h.active.stream)
  expect(await old).toBe(false)
  expect(h.active.track.stop).toHaveBeenCalledTimes(1)
  expect(next.track.stop).not.toHaveBeenCalled()
  expect(h.video.srcObject).toBe(next.stream)
  h.camera.dispose()
})

test("Stop while video.play waits cannot later report a successful start", async () => {
  const h = harness()
  const playback = deferred<void>()
  h.video.play.mockImplementation(() => playback.promise)
  const starting = h.camera.start()
  await Promise.resolve()
  h.camera.stop()
  playback.resolve()
  expect(await starting).toBe(false)
  expect(h.active.track.stop).toHaveBeenCalledTimes(1)
  h.camera.dispose()
})

test("a stale playback rejection does not close the replacement stream", async () => {
  const first = media(), second = media(), playback = deferred<void>()
  let calls = 0
  const h = harness(async () => ++calls === 1 ? first.stream : second.stream)
  h.video.play.mockImplementationOnce(() => playback.promise)
  const old = h.camera.start()
  await Promise.resolve()
  expect(await h.camera.start()).toBe(true)
  playback.reject(new Error("Old playback canceled"))
  expect(await old).toBe(false)
  expect(first.track.stop).toHaveBeenCalledTimes(1)
  expect(second.track.stop).not.toHaveBeenCalled()
  expect(h.video.srcObject).toBe(second.stream)
  h.camera.dispose()
})

test("an unexpected audio track is rejected and all acquired tracks are released", async () => {
  const video = new Track(), audio = new Track()
  const stream = {getTracks: () => [video, audio], getVideoTracks: () => [video], getAudioTracks: () => [audio]}
  const h = harness(async () => stream as unknown as MediaStream)
  await expect(h.camera.start()).rejects.toThrow("Unexpected microphone")
  expect(video.stop).toHaveBeenCalledTimes(1)
  expect(audio.stop).toHaveBeenCalledTimes(1)
  expect(h.camera.running).toBe(false)
  h.camera.dispose()
})

test.each(["hide", "ended"])("%s releases a running stream", async action => {
  const h = harness()
  await h.camera.start()
  if (action === "hide") {h.page.hidden = true; h.page.dispatchEvent(new Event("visibilitychange"))}
  else h.active.track.dispatchEvent(new Event("ended"))
  expect(h.camera.running).toBe(false)
  expect(h.video.srcObject).toBeNull()
  expect(h.active.track.stop).toHaveBeenCalledTimes(1)
  h.camera.dispose()
})

test("a visible-page event does not stop a live camera", async () => {
  const h = harness()
  await h.camera.start()
  h.page.dispatchEvent(new Event("visibilitychange"))
  expect(h.camera.running).toBe(true)
  h.camera.dispose()
})

test("playback failure releases acquired tracks", async () => {
  const h = harness()
  h.video.play.mockImplementation(async () => {throw new Error("Cannot play")})
  await expect(h.camera.start()).rejects.toThrow("Cannot play")
  expect(h.active.track.stop).toHaveBeenCalledTimes(1)
  expect(h.camera.running).toBe(false)
  h.camera.dispose()
})

test("capture/encoding failure releases the camera instead of returning empty data", async () => {
  const h = harness()
  await h.camera.start()
  h.canvases[0].toDataURL.mockImplementation(() => "data:,")
  expect(() => h.camera.sample(options)).toThrow("no JPEG")
  expect(h.camera.running).toBe(false)
  expect(h.active.track.stop).toHaveBeenCalledTimes(1)
  h.camera.dispose()
})

const running: PhoneCameraState = {enabled: true, cameraEnabled: true, visible: true,
  pickerOpen: false, connection: "listening", generation: 4, startGeneration: 4}

test("camera-run condition allows listening and speaking without requiring the mic", () => {
  expect(cameraShouldRun(running)).toBe(true)
  expect(cameraShouldRun({...running, connection: "speaking"})).toBe(true)
})

test.each([
  {enabled: false}, {cameraEnabled: false}, {visible: false}, {pickerOpen: true}, {startGeneration: 5},
  ...(["idle", "starting", "reconnecting", "stopping", "error"] as const).map(connection => ({connection})),
])("camera-run condition releases on ownership, capability or state loss: %j", change => {
  expect(cameraShouldRun({...running, ...change})).toBe(false)
})
