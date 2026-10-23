import {expect, mock, test} from "bun:test"
import {PhoneCamera, cameraShouldRun, type PhoneCameraState, type PhoneCameraStopReason} from "./phoneCamera"
import {compareSamples} from "../shared/frameComparison"

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
  const stream = {getTracks: () => [track], getVideoTracks: () => [track]}
  return {track, stream: stream as unknown as MediaStream}
}

function harness(acquire?: () => Promise<MediaStream>) {
  const active = media()
  const video = {srcObject: null as unknown, videoWidth: 480, videoHeight: 640,
    readyState: 2, muted: false, playsInline: false, play: mock(async () => {})}
  const contexts = [0, 1].map(() => ({
    imageSmoothingQuality: "low",
    drawImage: mock(() => {}),
    getImageData: mock(() => ({data: new Uint8ClampedArray([1, 2, 3, 0, 4, 5, 6, 255])})),
  }))
  const canvases = contexts.map(context => ({width: 0, height: 0,
    getContext: mock(() => context),
    toDataURL: mock(() => "data:image/jpeg;base64,/9j/fixture"),
  }))
  const page = {createElement: mock(() => canvases[page.createElement.mock.calls.length - 1])}
  const getUserMedia = mock(acquire ?? (async () => active.stream))
  const onStopped = mock((_reason: PhoneCameraStopReason) => {})
  const camera = new PhoneCamera(video as unknown as HTMLVideoElement, onStopped, {getUserMedia},
    page as unknown as Pick<Document, "createElement">)
  return {camera, active, video, getUserMedia, canvases, contexts, onStopped}
}

const options = {maxWidth: 320, jpegQuality: 0.7, comparisonWidth: 2, comparisonHeight: 1}

test("requests rear video without a second microphone and enables inline playback", async () => {
  const h = harness()
  expect(await h.camera.start()).toBe(true)
  expect(h.getUserMedia).toHaveBeenCalledWith({audio: false, video: {facingMode: {ideal: "environment"}}})
  expect(h.video.srcObject).toBe(h.active.stream)
  expect(h.video.muted && h.video.playsInline).toBe(true)
  h.camera.stop()
})

test("samples one portrait frame, strips the data URL and separates RGB from alpha", async () => {
  const h = harness()
  await h.camera.start()
  const before = Date.now()
  const sample = h.camera.sample(options)!
  expect(sample.canvas).toBe(h.canvases[0])
  expect(sample).toMatchObject({mimeType: "image/jpeg", data: "/9j/fixture", width: 320, height: 427,
    comparison: {width: 2, height: 1, data: new Uint8Array([1, 2, 3, 4, 5, 6])}})
  expect(sample.receivedAt).toBeGreaterThanOrEqual(before)
  expect(h.contexts[1].drawImage.mock.calls[0][0]).toBe(h.canvases[0])
  expect(h.canvases[0].toDataURL).toHaveBeenCalledWith("image/jpeg", 0.7)
  expect(h.canvases[1].getContext).toHaveBeenCalledWith("2d", {willReadFrequently: true})
  expect(h.contexts[1].imageSmoothingQuality).toBe("high")
  h.camera.stop()
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
  h.camera.stop()
  expect(h.camera.sample(options)).toBeNull()
})

test("rotation resets comparison even when the normalized thumbnail is unchanged", async () => {
  const h = harness()
  await h.camera.start()
  const portrait = h.camera.sample(options)!
  h.video.videoWidth = 640
  h.video.videoHeight = 480
  const landscape = h.camera.sample(options)!
  expect(portrait.comparison).toEqual(landscape.comparison)
  expect(compareSamples(portrait, landscape)).toBeNull()
  h.camera.stop()
})

test("stopped notification follows resource release and is emitted only once", async () => {
  const h = harness()
  h.onStopped.mockImplementation(() => {
    expect(h.video.srcObject).toBeNull()
    expect(h.active.track.readyState).toBe("ended")
  })
  await h.camera.start()
  h.camera.stop()
  h.camera.stop()
  expect(h.onStopped).toHaveBeenCalledTimes(1)
  expect(h.onStopped).toHaveBeenCalledWith("stopped")
})

test("permission refusal leaves no active camera and reports the error", async () => {
  const h = harness(async () => {throw new Error("Permission denied")})
  await expect(h.camera.start()).rejects.toThrow("Permission denied")
  expect(h.onStopped).toHaveBeenCalledWith("error")
  h.camera.stop()
})

test("stop during permission wait closes the late stream", async () => {
  const pending = deferred<MediaStream>()
  const h = harness(() => pending.promise)
  const starting = h.camera.start()
  h.camera.stop()
  pending.resolve(h.active.stream)
  expect(await starting).toBe(false)
  expect(h.active.track.stop).toHaveBeenCalledTimes(1)
  expect(h.video.srcObject).toBeNull()
  expect(h.onStopped).toHaveBeenCalledTimes(1)
  expect(h.onStopped).toHaveBeenCalledWith("stopped")
  h.camera.stop()
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
  expect(h.onStopped).not.toHaveBeenCalled()
  h.camera.stop()
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
  h.camera.stop()
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
  h.camera.stop()
})

test("an ended track releases a running stream", async () => {
  const h = harness()
  await h.camera.start()
  h.active.track.dispatchEvent(new Event("ended"))
  expect(h.onStopped).toHaveBeenCalledWith("ended")
  expect(h.video.srcObject).toBeNull()
  expect(h.active.track.stop).toHaveBeenCalledTimes(1)
  h.camera.stop()
  expect(h.onStopped).toHaveBeenCalledTimes(1)
})

test("playback failure releases acquired tracks", async () => {
  const h = harness()
  h.video.play.mockImplementation(async () => {throw new Error("Cannot play")})
  await expect(h.camera.start()).rejects.toThrow("Cannot play")
  expect(h.active.track.stop).toHaveBeenCalledTimes(1)
  expect(h.onStopped).toHaveBeenCalledWith("error")
  h.camera.stop()
})

test("capture/encoding failure releases the camera instead of returning empty data", async () => {
  const h = harness()
  await h.camera.start()
  h.canvases[0].toDataURL.mockImplementation(() => "data:,")
  expect(() => h.camera.sample(options)).toThrow("no JPEG")
  expect(h.onStopped).toHaveBeenCalledWith("error")
  expect(h.active.track.stop).toHaveBeenCalledTimes(1)
  h.camera.stop()
})

const running: PhoneCameraState = {enabled: true, cameraEnabled: true, visible: true,
  connection: "listening"}

test("camera-run condition includes reconnect without requiring the mic", () => {
  expect(cameraShouldRun(running)).toBe(true)
  expect(cameraShouldRun({...running, connection: "speaking"})).toBe(true)
  expect(cameraShouldRun({...running, connection: "reconnecting"})).toBe(true)
})

test.each([
  {enabled: false}, {cameraEnabled: false}, {visible: false},
  ...(["idle", "starting", "stopping", "error"] as const).map(connection => ({connection})),
])("camera-run condition releases on capability or state loss: %j", change => {
  expect(cameraShouldRun({...running, ...change})).toBe(false)
})
