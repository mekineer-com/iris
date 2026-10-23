import type {ConnectionState} from "../shared/types"
import type {FrameSample} from "../shared/frameComparison"

export interface PhoneCameraState {
  enabled: boolean
  cameraEnabled: boolean
  visible: boolean
  connection: ConnectionState
  generation: number
  startGeneration: number
}

export function cameraShouldRun(state: PhoneCameraState): boolean {
  return state.enabled && state.cameraEnabled && state.visible &&
    state.generation === state.startGeneration &&
    (state.connection === "listening" || state.connection === "speaking" || state.connection === "reconnecting")
}

export interface CameraSample extends FrameSample {
  mimeType: "image/jpeg"
  data: string
  receivedAt: number
}

export type PhoneCameraStopReason = "stopped" | "ended" | "error"

export interface CameraSampleOptions {
  maxWidth: number
  jpegQuality: number
  comparisonWidth: number
  comparisonHeight: number
}

// Adapted from the tested phone-camera-probe. The caller owns cadence, naming and delivery.
export class PhoneCamera {
  private generation = 0
  private starting = false
  private stream: MediaStream | null = null
  private ended: (() => void) | null = null
  private readonly canvas: HTMLCanvasElement
  private readonly comparisonCanvas: HTMLCanvasElement

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onStopped: (reason: PhoneCameraStopReason) => void,
    private readonly mediaDevices: Pick<MediaDevices, "getUserMedia"> = navigator.mediaDevices,
    page: Pick<Document, "createElement"> = document,
  ) {
    this.canvas = page.createElement("canvas")
    this.comparisonCanvas = page.createElement("canvas")
    video.muted = true
    video.playsInline = true
  }

  // False means this attempt was canceled/superseded; actual startup failures reject.
  async start(): Promise<boolean> {
    this.release()
    this.starting = true
    const owner = this.generation
    try {
      const stream = await this.mediaDevices.getUserMedia({audio: false,
        video: {facingMode: {ideal: "environment"}}})
      if (owner !== this.generation) {
        stream.getTracks().forEach(track => track.stop())
        return false
      }
      this.stream = stream
      this.ended = () => {if (this.stream === stream) this.stop("ended")}
      stream.getVideoTracks().forEach(track => track.addEventListener("ended", this.ended!))
      this.video.srcObject = stream
      await this.video.play()
      return owner === this.generation
    } catch (error) {
      if (owner !== this.generation) return false
      this.stop("error")
      throw error
    } finally {
      if (owner === this.generation) this.starting = false
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
      const comparisonContext = this.comparisonCanvas.getContext("2d", {willReadFrequently: true})!
      comparisonContext.imageSmoothingQuality = "high"
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
      this.stop("error")
      throw error
    }
  }

  private release(): boolean {
    const active = this.starting || this.stream !== null
    this.starting = false
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
    return active
  }

  stop(reason: PhoneCameraStopReason = "stopped"): void {
    if (this.release()) this.onStopped(reason)
  }

  dispose(): void {
    this.stop()
  }
}
