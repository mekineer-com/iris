import type {ConnectionState} from "../shared/types"
import type {RgbFrame} from "../shared/frameComparison"

export interface PhoneCameraState {
  enabled: boolean
  cameraEnabled: boolean
  visible: boolean
  pickerOpen: boolean
  connection: ConnectionState
  generation: number
  startGeneration: number
}

export function cameraShouldRun(state: PhoneCameraState): boolean {
  return state.enabled && state.cameraEnabled && state.visible && !state.pickerOpen &&
    state.generation === state.startGeneration &&
    (state.connection === "listening" || state.connection === "speaking")
}

export interface CameraSample {
  mimeType: "image/jpeg"
  data: string
  width: number
  height: number
  receivedAt: number
  comparison: RgbFrame
}

export interface CameraSampleOptions {
  maxWidth: number
  jpegQuality: number
  comparisonWidth: number
  comparisonHeight: number
}

// Adapted from the tested phone-camera-probe. The caller owns cadence, naming and delivery.
export class PhoneCamera {
  private generation = 0
  private stream: MediaStream | null = null
  private ended: (() => void) | null = null
  private readonly canvas: HTMLCanvasElement
  private readonly comparisonCanvas: HTMLCanvasElement
  private readonly hide = () => {if (this.page.hidden) this.stop()}
  private readonly pagehide = () => this.stop()

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly mediaDevices: Pick<MediaDevices, "getUserMedia"> = navigator.mediaDevices,
    private readonly page: Document = document,
    private readonly browser: Window = window,
  ) {
    this.canvas = page.createElement("canvas")
    this.comparisonCanvas = page.createElement("canvas")
    video.muted = true
    video.playsInline = true
    page.addEventListener("visibilitychange", this.hide)
    browser.addEventListener("pagehide", this.pagehide)
  }

  get running(): boolean {return this.stream !== null}

  async start(): Promise<boolean> {
    this.stop()
    const owner = this.generation
    try {
      const stream = await this.mediaDevices.getUserMedia({audio: false,
        video: {facingMode: {ideal: "environment"}}})
      if (owner !== this.generation) {
        stream.getTracks().forEach(track => track.stop())
        return false
      }
      this.stream = stream
      if (stream.getAudioTracks().length) throw new Error("Unexpected microphone track")
      this.ended = () => {if (this.stream === stream) this.stop()}
      stream.getVideoTracks().forEach(track => track.addEventListener("ended", this.ended!))
      this.video.srcObject = stream
      await this.video.play()
      return owner === this.generation
    } catch (error) {
      if (owner !== this.generation) return false
      this.stop()
      throw error
    }
  }

  sample(options: CameraSampleOptions): CameraSample | null {
    if (!this.stream || this.video.readyState < 2 || !this.video.videoWidth || !this.video.videoHeight) return null
    try {
      const receivedAt = Date.now()
      this.canvas.width = Math.min(options.maxWidth, this.video.videoWidth)
      this.canvas.height = Math.max(1, Math.round(this.video.videoHeight * this.canvas.width / this.video.videoWidth))
      const context = this.canvas.getContext("2d")!
      context.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height)

      this.comparisonCanvas.width = options.comparisonWidth
      this.comparisonCanvas.height = options.comparisonHeight
      const comparisonContext = this.comparisonCanvas.getContext("2d")!
      comparisonContext.drawImage(this.canvas, 0, 0, options.comparisonWidth, options.comparisonHeight)
      const rgba = comparisonContext.getImageData(0, 0, options.comparisonWidth, options.comparisonHeight).data
      const rgb = new Uint8Array(options.comparisonWidth * options.comparisonHeight * 3)
      for (let pixel = 0; pixel < rgb.length / 3; pixel++) {
        rgb[pixel * 3] = rgba[pixel * 4]
        rgb[pixel * 3 + 1] = rgba[pixel * 4 + 1]
        rgb[pixel * 3 + 2] = rgba[pixel * 4 + 2]
      }
      const dataUrl = this.canvas.toDataURL("image/jpeg", options.jpegQuality)
      const prefix = "data:image/jpeg;base64,"
      if (!dataUrl.startsWith(prefix) || dataUrl.length === prefix.length) throw new Error("Camera produced no JPEG")
      return {mimeType: "image/jpeg", data: dataUrl.slice(prefix.length),
        width: this.canvas.width, height: this.canvas.height, receivedAt,
        comparison: {width: options.comparisonWidth, height: options.comparisonHeight, data: rgb}}
    } catch (error) {
      this.stop()
      throw error
    }
  }

  stop(): void {
    this.generation++
    const stream = this.stream
    const ended = this.ended
    this.stream = null
    this.ended = null
    if (stream) {
      stream.getVideoTracks().forEach(track => {if (ended) track.removeEventListener("ended", ended)})
      stream.getTracks().forEach(track => track.stop())
    }
    this.video.srcObject = null
  }

  dispose(): void {
    this.stop()
    this.page.removeEventListener("visibilitychange", this.hide)
    this.browser.removeEventListener("pagehide", this.pagehide)
  }
}
