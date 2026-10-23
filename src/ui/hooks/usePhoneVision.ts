import {useCallback, useEffect, useRef, useState} from "react"
import {useRpc} from "@mentra/miniapp/ui"
import type {Channels} from "../../shared/channels"
import {VISION_SETTINGS as settings, type SessionSnapshot} from "../../shared/types"
import {formatImageTimestamp} from "../../shared/imageReference"
import {compareSamples, type FrameSample} from "../../shared/frameComparison"
import {PhoneCamera, cameraShouldRun} from "../phoneCamera"
import {stampImage} from "../stampImage"
import {renderCatchUpCollage} from "../catchUpCollage"

function jpeg(canvas: HTMLCanvasElement): string {
  const data = canvas.toDataURL("image/jpeg", settings.jpegQuality)
  const prefix = "data:image/jpeg;base64,"
  if (!data.startsWith(prefix) || data.length === prefix.length) throw new Error("Camera produced no JPEG")
  return data.slice(prefix.length)
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const canceled = (error: unknown) => !!error && typeof error === "object" && "name" in error && error.name === "AbortError"
const timedOut = (error: unknown) => !!error && typeof error === "object" && "name" in error && error.name === "MentraRpcTimeoutError"
const connected = (snapshot: SessionSnapshot | undefined) =>
  snapshot?.connection === "listening" || snapshot?.connection === "speaking"

export function usePhoneVision(snapshot: SessionSnapshot | undefined, foreground: boolean) {
  const reserve = useRpc<Channels, "openalma:reserve-image">("openalma:reserve-image")
  const intake = useRpc<Channels, "openalma:frame">("openalma:frame")
  const read = useRpc<Channels, "openalma:frames">("openalma:frames")
  const rendered = useRpc<Channels, "openalma:catch-up-rendered">("openalma:catch-up-rendered")
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const cameraRef = useRef<PhoneCamera | null>(null)
  const ownerRef = useRef<object | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const latest = useRef({snapshot, foreground})
  const refresh = useRef<object | null>({})
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if ((!latest.current.snapshot?.frameDeliveryOpen && snapshot?.frameDeliveryOpen) ||
      (latest.current.snapshot?.catchUpRender && !snapshot?.catchUpRender)) refresh.current = {}
  latest.current = {snapshot, foreground}
  const generation = snapshot?.startGeneration
  const run = !!snapshot && cameraShouldRun({enabled: snapshot.callMode === "video",
    cameraEnabled: snapshot.cameraEnabled, visible: foreground, connection: snapshot.connection})

  const stop = useCallback(() => {
    ownerRef.current = null
    if (timerRef.current !== null) clearInterval(timerRef.current)
    timerRef.current = null
    cameraRef.current?.stop()
    cameraRef.current = null
    reserve.abort(); intake.abort(); read.abort(); rendered.abort()
    setReady(false)
  }, [reserve, intake, read, rendered])

  useEffect(() => {
    if (!run || !videoRef.current) {setError(null); return}
    const owner = {}
    ownerRef.current = owner
    let alive = true
    let busy = false
    let baseline: FrameSample | null = null
    refresh.current = {}
    setError(null)
    const current = () => {
      const snapshot = latest.current.snapshot
      return alive && ownerRef.current === owner && latest.current.foreground && !!snapshot &&
        snapshot.startGeneration === generation && snapshot.callMode === "video" &&
        snapshot.cameraEnabled && connected(snapshot)
    }
    const camera = new PhoneCamera(videoRef.current, reason => {
      if (ownerRef.current !== owner) return
      stop()
      if (reason !== "stopped") setError("Camera stopped. Turn Camera enabled off and on to retry.")
    })
    cameraRef.current = camera
    const sample = async () => {
      if (busy || !current()) return
      busy = true
      try {
        const video = videoRef.current!
        const maxWidth = Math.min(video.videoWidth, Math.floor(settings.maxWidth * video.videoWidth /
          Math.max(video.videoWidth, video.videoHeight)))
        const frame = camera.sample({...settings, maxWidth})
        if (!frame) return
        const refreshRequest = refresh.current
        const difference = baseline ? compareSamples(baseline, frame) : null
        if (difference && difference.wholeMean === 0 && difference.peakBlockMean === 0 &&
            !(refresh.current && latest.current.snapshot?.frameDeliveryOpen)) return
        const time = {timestamp: formatImageTimestamp(frame.receivedAt), source: "receipt" as const,
          receivedAt: frame.receivedAt}
        const reference = await reserve({startGeneration: generation!, time}, {timeout: settings.capturePeriodMs})
        if (!current() || reference.startGeneration !== generation) return
        // Sampling is serial; deliberate stills use another canvas while this one awaits reservation.
        const model = stampImage(frame.canvas, reference.imageId, settings.maxWidth)
        const modelData = jpeg(model)
        model.width = model.height = 0
        const result = await intake({...reference, time,
          mimeType: frame.mimeType, data: frame.data, modelData}, {timeout: settings.capturePeriodMs})
        if (!current()) return
        if (result.retained || result.delivery === "sent") {
          baseline = {width: frame.width, height: frame.height, comparison: frame.comparison}
          setError(null)
        }
        // A late reply cannot consume a refresh requested by a newer context.
        if (result.delivery === "sent" && refresh.current === refreshRequest) refresh.current = null
      } catch (error) {
        if (alive && !canceled(error)) {
          console.warn("Video frame not confirmed:", message(error))
          if (current() && !timedOut(error)) setError(`Video frame not confirmed: ${message(error)}`)
        }
      } finally { busy = false }
    }
    void camera.start().then(started => {
      if (!alive || ownerRef.current !== owner || !started) return
      setReady(true)
      void sample()
      timerRef.current = setInterval(() => void sample(), settings.capturePeriodMs)
    }).catch(error => {if (alive) setError(message(error))})
    return () => {alive = false; stop()}
  }, [run, generation, reserve, intake, stop])

  const renderId = snapshot?.catchUpRender?.renderId
  const canRender = run && ready && connected(snapshot)
  useEffect(() => {
    if (!canRender || !renderId || !snapshot?.catchUpRender) return
    const imageIds = snapshot.catchUpRender.imageIds
    const owner = ownerRef.current
    let alive = true
    let submitted = false
    const images: HTMLImageElement[] = []
    const current = () => {
      const snapshot = latest.current.snapshot
      return alive && owner !== null && ownerRef.current === owner && latest.current.foreground && !!snapshot &&
        snapshot.startGeneration === generation && snapshot.cameraEnabled &&
        snapshot.catchUpRender?.renderId === renderId && connected(snapshot)
    }
    void (async () => {
      try {
        const {frames} = await read({startGeneration: generation!, imageIds}, {timeout: settings.capturePeriodMs})
        if (!current()) return
        if (frames.length !== imageIds.length || new Set(frames.map(frame => frame.imageId)).size !== imageIds.length ||
            frames.some(frame => !imageIds.includes(frame.imageId))) throw new Error("Catch-up originals do not match the requested frames")
        const decoded = []
        for (const frame of frames) {
          const image = new Image()
          images.push(image)
          image.src = `data:${frame.mimeType};base64,${frame.data}`
          await image.decode()
          if (!current()) return
          decoded.push({image, imageId: frame.imageId, receivedAt: frame.time.receivedAt})
        }
        const canvas = renderCatchUpCollage(decoded, {width: settings.collageWidth,
          height: settings.collageHeight, columns: settings.collageColumns, gap: settings.collageGap})
        const data = jpeg(canvas)
        canvas.width = canvas.height = 0
        if (!current()) return
        submitted = true
        await rendered({startGeneration: generation!, renderId, data}, {timeout: settings.capturePeriodMs})
      } catch (error) {
        if (!current() || canceled(error)) return
        console.warn("Catch-up rendering not confirmed:", message(error))
        setError(`Catch-up rendering not confirmed: ${message(error)}`)
        if (!submitted) await rendered({startGeneration: generation!, renderId, error: message(error)},
          {timeout: settings.capturePeriodMs}).catch(() => {})
      } finally {for (const image of images) image.src = ""}
    })()
    return () => {alive = false; read.abort(); rendered.abort(); for (const image of images) image.src = ""}
  }, [canRender, renderId, generation, read, rendered])

  const takePhoto = useCallback(async () => {
    const owner = ownerRef.current
    const video = videoRef.current
    if (!owner || !video || !cameraRef.current || !connected(latest.current.snapshot) || video.readyState < 2) {
      throw new Error("Camera is not ready")
    }
    const receivedAt = Date.now()
    const canvas = document.createElement("canvas")
    canvas.width = video.videoWidth; canvas.height = video.videoHeight
    canvas.getContext("2d")!.drawImage(video, 0, 0)
    try {
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value =>
        value ? resolve(value) : reject(new Error("Camera produced no JPEG")), "image/jpeg", settings.jpegQuality))
      if (ownerRef.current !== owner) throw new Error("Photo belongs to an inactive camera")
      return {file: new File([blob], "video-photo.jpg", {type: "image/jpeg", lastModified: receivedAt}), receivedAt}
    } finally {canvas.width = canvas.height = 0}
  }, [])

  return {videoRef, ready, error, stop, takePhoto}
}
