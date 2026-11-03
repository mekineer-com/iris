import {expect, mock, test} from "bun:test"
import {readFileSync} from "node:fs"
import {runInNewContext} from "node:vm"
import ts from "typescript"
import * as cameraModule from "../phoneCamera"
import * as types from "../../shared/types"
import * as references from "../../shared/imageReference"
import * as comparison from "../../shared/frameComparison"

test.each([false, true])("first capture failure leaves no camera timer (capture fails=%s)", async fails => {
  const effects: Array<() => void | (() => void)> = []
  const intervals = new Set<object>()
  const errors: unknown[] = []
  const video = {srcObject: null, videoWidth: 480, videoHeight: 640, readyState: 2, play: async () => {}}
  const track = {stop: mock(() => {}), addEventListener() {}, removeEventListener() {}}
  const mediaDevices = {getUserMedia: async () => ({getTracks: () => [track], getVideoTracks: () => [track]}) as unknown as MediaStream}
  const sample = mock(() => fails ? "data:," : "data:image/jpeg;base64,AQID")
  const page = {createElement: () => ({width: 0, height: 0, toDataURL: sample,
    getContext: () => ({drawImage() {}, getImageData: () => ({data: new Uint8ClampedArray(
      types.VISION_SETTINGS.comparisonWidth * types.VISION_SETTINGS.comparisonHeight * 4)})}),
  })} as unknown as Pick<Document, "createElement">
  class Camera extends cameraModule.PhoneCamera {
    constructor(element: HTMLVideoElement, onStopped: (reason: cameraModule.PhoneCameraStopReason) => void) {
      super(element, onStopped, mediaDevices, page)
    }
  }
  const context = {
    exports: {}, console: {warn() {}},
    setInterval: () => {const timer = {}; intervals.add(timer); return timer},
    clearInterval: (timer: object) => intervals.delete(timer),
    require(name: string) {
      if (name === "react") return {
        useRef: (current: unknown) => ({current}), useCallback: (callback: unknown) => callback,
        useState: (initial: unknown) => [initial, (value: unknown) => {if (typeof value === "string") errors.push(value)}],
        useEffect: (effect: () => void | (() => void)) => effects.push(effect),
      }
      if (name === "@mentra/miniapp/ui") return {useRpc: () => Object.assign(
        () => new Promise(() => {}), {abort() {}})}
      if (name.endsWith("/phoneCamera")) return {...cameraModule, PhoneCamera: Camera}
      if (name.endsWith("/shared/types")) return types
      if (name.endsWith("/shared/imageReference")) return references
      if (name.endsWith("/shared/frameComparison")) return comparison
      return {}
    },
  }
  const source = readFileSync(new URL("./usePhoneVision.ts", import.meta.url), "utf8")
  runInNewContext(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText, context)
  const hook = (context.exports as {usePhoneVision: (snapshot: unknown, foreground: boolean) => {
    videoRef: {current: unknown}
  }}).usePhoneVision({connection: "listening", callMode: "video", cameraEnabled: true, startGeneration: 1}, true)
  hook.videoRef.current = video
  const cleanup = effects[0]()
  try {
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sample).toHaveBeenCalledTimes(1)
    expect(intervals.size).toBe(fails ? 0 : 1)
    if (fails) {
      expect(video.srcObject).toBeNull()
      expect(track.stop).toHaveBeenCalledTimes(1)
      expect(errors).toEqual(["Camera stopped. Turn Camera enabled off and on to retry."])
    } else expect(errors).toEqual([])
  } finally {if (cleanup) cleanup()}
  expect(intervals.size).toBe(0)
  expect(track.stop).toHaveBeenCalledTimes(1)
})
