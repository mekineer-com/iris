import {useEffect, useRef, useState} from "react"
import {flushSync} from "react-dom"
import {useRpc} from "@mentra/miniapp/ui"

import type {Channels, ImageRequest, SelectSoulResult} from "../../shared/channels"
import {readImageTime, type ImageTime} from "../imageTime"
import {
  LIVE_MODELS,
  PHOTO_RETRY_MESSAGE,
  type CallMode,
  type ConnectionState,
  type LiveModel,
  type ManualAction,
  type ManualPhase,
  type OpenAlmaProfile,
  type SessionMode,
} from "../../shared/types"
import {useChannel} from "../hooks/useChannel"
import {usePhoneVision} from "../hooks/usePhoneVision"
import memuIcon from "../memu-icon.png"
import manifest from "../../../miniapp.json"

function unreachable(value: never): never {
  throw new Error(`Unhandled session state: ${value}`)
}

export function statusText(connection: ConnectionState, mode: SessionMode, manualPhase: ManualPhase, soulId: string, microphoneEnabled: boolean): string {
  switch (connection) {
    case "starting": return "Starting..."
    case "reconnecting": return "Reconnecting..."
    case "stopping": return "Stopping..."
    case "error": return "Error"
    case "speaking": return "Speaking"
    case "idle": return "Idle"
    case "listening": break
    default: return unreachable(connection)
  }
  if (mode === "continuous") return microphoneEnabled ? "Listening" : "Microphone off"
  if (mode !== "manual") return unreachable(mode)
  switch (manualPhase) {
    case "idle": return microphoneEnabled ? "Ready" : "Microphone off"
    case "recording": return microphoneEnabled ? "Recording..." : "Microphone off"
    case "review": return "Review recording"
    case "submitted": return `Waiting for ${soulId}...`
    default: return unreachable(manualPhase)
  }
}

export function visibleConnection(
  connection: ConnectionState,
  startPending: boolean,
  stopPending: boolean,
): ConnectionState {
  if (stopPending) return "stopping"
  if (startPending && (connection === "idle" || connection === "error")) return "starting"
  return connection
}

const LARGE_IMAGE_BYTES = 1024 * 1024
const LARGE_IMAGE_WARNING_KEY = "openalma.dismiss-large-image-warning"

export function validateImageFile(file: Pick<File, "size" | "type">): "image/jpeg" | "image/png" {
  if (file.type !== "image/jpeg" && file.type !== "image/png") throw new Error("Choose a JPEG or PNG image")
  if (file.size <= 0) throw new Error("Photo is empty")
  return file.type
}

export const shouldWarnLargeImage = (size: number, warningDismissed: boolean) =>
  size > LARGE_IMAGE_BYTES && !warningDismissed

export const stopSecondsRemaining = (deadline: number, now = Date.now()) =>
  Math.max(0, Math.ceil((deadline - now) / 1000))

export async function imageRequest(
  file: File,
  imageId: string,
  speakDescription: boolean,
): Promise<ImageRequest> {
  const mimeType = validateImageFile(file)
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return {imageId, mimeType, data: btoa(binary), speakDescription}
}

type PendingPhoto = {file: File; imageId: string; time: ImageTime; previewUrl: string | null}

export default function SessionPage() {
  const snapshot = useChannel("openalma:update")
  const profileRpc = useRpc<Channels, "openalma:set-profile">("openalma:set-profile")
  const startRpc = useRpc<Channels, "openalma:start">("openalma:start")
  const stopRpc = useRpc<Channels, "openalma:stop">("openalma:stop")
  const closingThoughtsRpc = useRpc<Channels, "openalma:set-closing-thoughts">("openalma:set-closing-thoughts")
  const soulRpc = useRpc<Channels, "openalma:set-soul">("openalma:set-soul")
  const modeRpc = useRpc<Channels, "openalma:set-mode">("openalma:set-mode")
  const modelRpc = useRpc<Channels, "openalma:set-model">("openalma:set-model")
  const capabilitiesRpc = useRpc<Channels, "openalma:set-capabilities">("openalma:set-capabilities")
  const manualRpc = useRpc<Channels, "openalma:manual-action">("openalma:manual-action")
  const imageRpc = useRpc<Channels, "openalma:image">("openalma:image")
  const reserveImageRpc = useRpc<Channels, "openalma:reserve-image">("openalma:reserve-image")
  const pendingImageRpc = useRpc<Channels, "openalma:pending-image">("openalma:pending-image")
  const [startPending, setStartPending] = useState(false)
  const [stopPending, setStopPending] = useState(false)
  const [closingThoughtsPending, setClosingThoughtsPending] = useState(false)
  const [stopNow, setStopNow] = useState(Date.now)
  const [soulName, setSoulName] = useState("")
  const [soulDirty, setSoulDirty] = useState(true)
  const [soulPending, setSoulPending] = useState(false)
  const [soulMenuOpen, setSoulMenuOpen] = useState(false)
  const [pendingNewSoul, setPendingNewSoul] = useState<string | null>(null)
  const [showNewSoulInfo, setShowNewSoulInfo] = useState(false)
  const [confirmationSoul, setConfirmationSoul] = useState<string | null>(null)
  const [modePending, setModePending] = useState(false)
  const [modelPending, setModelPending] = useState(false)
  const [capabilitiesPending, setCapabilitiesPending] = useState(false)
  const [manualPending, setManualPending] = useState(false)
  const [previewImages, setPreviewImages] = useState(false)
  const [speakPhotoDescriptions, setSpeakPhotoDescriptions] = useState(false)
  const [largeImageWarningDismissed, setLargeImageWarningDismissed] = useState(
    () => localStorage.getItem(LARGE_IMAGE_WARNING_KEY) === "1",
  )
  const [pendingPhoto, setPendingPhoto] = useState<PendingPhoto | null>(null)
  const [imagePending, setImagePending] = useState(false)
  const [filingPending, setFilingPending] = useState<string | null>(null)
  const [imageStatus, setImageStatus] = useState<string | null>(null)
  const [rpcError, setRpcError] = useState<string | null>(null)
  const [profilePending, setProfilePending] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [foreground, setForeground] = useState(() => !document.hidden)
  const [maxPhotosDraft, setMaxPhotosDraft] = useState<number | null>(null)
  const [maxPhotosPending, setMaxPhotosPending] = useState(false)
  const maxPhotosSaving = useRef(false)
  const maxPhotosDesired = useRef<number | null>(null)
  const maxPhotosRpc = useRpc<Channels, "openalma:set-max-memorized-photos">("openalma:set-max-memorized-photos")
  const [editingConnection, setEditingConnection] = useState(false)
  const [profile, setProfile] = useState<OpenAlmaProfile>({
    baseUrl: "",
    userId: "",
    deviceSessionId: "",
  })
  const startOwner = useRef(0)
  const imageOwner = useRef(0)
  const pickerGeneration = useRef<number | null>(null)
  const filingOwner = useRef(0)

  useEffect(() => {
    if (settingsOpen && !editingConnection) {
      document.getElementById("iris-settings")?.scrollIntoView({block: "nearest"})
    }
  }, [settingsOpen, editingConnection])

  useEffect(() => () => {
    if (pendingPhoto?.previewUrl) URL.revokeObjectURL(pendingPhoto.previewUrl)
  }, [pendingPhoto?.previewUrl])

  useEffect(() => {
    setSoulName(snapshot?.soulId ?? "")
    setSoulDirty(!(snapshot?.soulConfirmed ?? false))
    setPendingNewSoul(null)
    setShowNewSoulInfo(false)
    imageOwner.current += 1
    filingOwner.current += 1
    setFilingPending(null)
    setPendingPhoto(null)
    setImagePending(false)
    setImageStatus(null)
  }, [snapshot?.soulId, snapshot?.soulConfirmed])

  const discardPhoto = () => {
    setPendingPhoto(null)
  }

  const connection = snapshot?.connection ?? "idle"
  const mode = snapshot?.mode ?? "continuous"
  const manualPhase = snapshot?.manualPhase ?? "idle"
  const photoRetryPending = snapshot?.photoRetryPending ?? false
  const microphoneEnabled = snapshot?.microphoneEnabled ?? true
  const cameraEnabled = snapshot?.cameraEnabled ?? true
  const closingThoughts = snapshot?.closingThoughts ?? true
  const visible = visibleConnection(connection, startPending, stopPending)
  const starting = visible === "starting"
  const stopping = visible === "stopping"
  const stopDeadline = snapshot?.stopDeadlineAt ?? null
  const callMode = snapshot?.callMode ?? "audio"
  const vision = usePhoneVision(snapshot, foreground && !stopPending)
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const publish = (foreground: boolean) => {
      if (!foreground) vision.stop()
      setForeground(foreground)
      mentra.send("openalma:visibility", {visible: foreground})
      setStopNow(Date.now())
      if (timer !== undefined) clearInterval(timer)
      timer = stopping && foreground ? setInterval(() => setStopNow(Date.now()), 1000) : undefined
    }
    // Commit hide before a quick show can fold it away and strand the stopped camera.
    const visibility = () => flushSync(() => publish(!document.hidden))
    const hide = () => flushSync(() => publish(false))
    document.addEventListener("visibilitychange", visibility)
    window.addEventListener("pagehide", hide)
    window.addEventListener("pageshow", visibility)
    publish(!document.hidden)
    return () => {
      document.removeEventListener("visibilitychange", visibility)
      window.removeEventListener("pagehide", hide)
      window.removeEventListener("pageshow", visibility)
      if (timer !== undefined) clearInterval(timer)
    }
  }, [stopping])
  const reconnecting = visible === "reconnecting"
  const active = starting || reconnecting || visible === "listening" || visible === "speaking"
  const videoCall = callMode === "video" && (active || stopping)
  const modeDisabled = active || stopping || startPending || stopPending || modePending
  const modelSaving = modelPending || snapshot?.modelSaving === true
  const modelDisabled = active || stopping || startPending || stopPending || modelSaving
  const soulLocked = snapshot?.soulLocked ?? true
  const connectionLocked = (snapshot?.connectionLocked ?? true) || active || stopping || soulPending
  const soulReady = !soulDirty && snapshot?.soulConfirmed && soulName.trim() === snapshot.soulId
  const knownSoul = snapshot?.souls.includes(soulName.trim()) ?? false

  const selectSoul = async (soulId: string, useExisting: boolean): Promise<boolean> => {
    setRpcError(null)
    setSoulPending(true)
    try {
      const result = await soulRpc({soulId, useExisting}) as SelectSoulResult
      if ("confirmationRequired" in result) {
        setConfirmationSoul(result.soulId)
        return false
      }
      setSoulName(result.soulId)
      setSoulDirty(false)
      setPendingNewSoul(null)
      setConfirmationSoul(null)
      return true
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setSoulPending(false)
    }
  }

  const editConnection = () => {
    if (snapshot?.connectionProfile) setProfile({...profile, ...snapshot.connectionProfile})
    setRpcError(null)
    setEditingConnection(true)
  }

  const submitSoul = async (): Promise<void> => {
    const soulId = soulName.trim()
    if (knownSoul) {
      setPendingNewSoul(null)
      await selectSoul(soulId, true)
    } else {
      setRpcError(null)
      setSoulDirty(false)
      setPendingNewSoul(soulId)
      setShowNewSoulInfo(false)
    }
  }

  const onStart = async (callMode: CallMode) => {
    if (maxPhotosSaving.current) return
    const owner = ++startOwner.current
    imageOwner.current += 1
    filingOwner.current += 1
    setFilingPending(null)
    setImagePending(false)
    setRpcError(null)
    setStartPending(true)
    try {
      if (!soulReady) {
        if (pendingNewSoul !== soulName.trim() || !await selectSoul(soulName.trim(), false)) return
      }
      if (owner !== startOwner.current) return
      await startRpc({mode, callMode})
    } catch (error) {
      if (owner === startOwner.current) {
        setRpcError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (owner === startOwner.current) setStartPending(false)
    }
  }

  const onStop = async () => {
    vision.stop()
    startOwner.current += 1
    setStartPending(false)
    setRpcError(null)
    setStopPending(true)
    imageOwner.current += 1
    filingOwner.current += 1
    setFilingPending(null)
    setImagePending(false)
    discardPhoto()
    try {
      await stopRpc({})
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : String(error))
    } finally {
      setStopPending(false)
    }
  }

  const onMode = async (next: SessionMode) => {
    setRpcError(null)
    setModePending(true)
    imageOwner.current += 1
    setImagePending(false)
    discardPhoto()
    try {
      await modeRpc({mode: next})
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : String(error))
    } finally {
      setModePending(false)
    }
  }

  const onModel = async (model: LiveModel) => {
    setRpcError(null)
    setModelPending(true)
    try {
      await modelRpc({model})
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : String(error))
    } finally {
      setModelPending(false)
    }
  }

  const onManual = async (action: ManualAction) => {
    setRpcError(null)
    setManualPending(true)
    try {
      await manualRpc({action})
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : String(error))
    } finally {
      setManualPending(false)
    }
  }

  const onCapability = async (
    capability: "microphoneEnabled" | "cameraEnabled",
    enabled: boolean,
  ) => {
    setRpcError(null)
    setCapabilitiesPending(true)
    try {
      await capabilitiesRpc({[capability]: enabled})
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : String(error))
    } finally {
      setCapabilitiesPending(false)
    }
  }

  const onClosingThoughts = async (enabled: boolean) => {
    setRpcError(null)
    setClosingThoughtsPending(true)
    try {
      await closingThoughtsRpc({enabled})
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : String(error))
    } finally {
      setClosingThoughtsPending(false)
    }
  }

  const submitPhoto = async (photo: PendingPhoto) => {
    const owner = ++imageOwner.current
    setRpcError(null)
    setImageStatus(null)
    setImagePending(true)
    try {
      const request = await imageRequest(photo.file, photo.imageId, speakPhotoDescriptions)
      if (owner !== imageOwner.current) return
      const result = await imageRpc({...request, time: photo.time})
      if (owner !== imageOwner.current) return
      if (!result.ok) {
        const reference = await reserveImageRpc({startGeneration: snapshot!.startGeneration, time: photo.time})
        if (owner !== imageOwner.current) return
        setPendingPhoto({...photo, imageId: reference.imageId})
        setRpcError("Photo reference was already in use. Retry will use a new reference.")
        setImageStatus("Photo ready to retry")
        return
      }
      discardPhoto()
      setImageStatus("Photo sent")
    } catch (error) {
      if (owner !== imageOwner.current) return
      setPendingPhoto(photo)
      setRpcError(error instanceof Error ? error.message : String(error))
      setImageStatus("Photo ready to retry")
    } finally {
      if (owner === imageOwner.current) setImagePending(false)
    }
  }

  const preparePhoto = async (file: File, generation: number, receivedAt: number) => {
    setRpcError(null)
    setImageStatus(null)
    try {
      validateImageFile(file)
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : String(error))
      return
    }
    const owner = ++imageOwner.current
    setImagePending(true)
    try {
      const time = await readImageTime(file, receivedAt)
      if (owner !== imageOwner.current) return
      const reference = await reserveImageRpc({startGeneration: generation, time})
      if (owner !== imageOwner.current || reference.startGeneration !== generation) return
      discardPhoto()
      const warnLarge = shouldWarnLargeImage(file.size, largeImageWarningDismissed)
      const photo = {
        file, time, imageId: reference.imageId,
        previewUrl: previewImages || warnLarge ? URL.createObjectURL(file) : null,
      }
      setPendingPhoto(photo)
      if (!previewImages && !warnLarge) await submitPhoto(photo)
    } catch (error) {
      if (owner === imageOwner.current) setRpcError(error instanceof Error ? error.message : String(error))
    } finally {
      if (owner === imageOwner.current) setImagePending(false)
    }
  }

  const onImagePicked = async (input: HTMLInputElement) => {
    const file = input.files?.[0]
    input.value = ""
    const generation = pickerGeneration.current
    pickerGeneration.current = null
    if (!file) return
    if (generation === null || generation !== snapshot?.startGeneration) {
      setRpcError("Choose the photo again for this sitting.")
      return
    }
    await preparePhoto(file, generation, Date.now())
  }

  const onVideoPhoto = async () => {
    const owner = ++imageOwner.current
    const generation = snapshot!.startGeneration
    setImagePending(true)
    setRpcError(null)
    try {
      const photo = await vision.takePhoto()
      if (owner === imageOwner.current) await preparePhoto(photo.file, generation, photo.receivedAt)
    } catch (error) {
      if (owner === imageOwner.current) setRpcError(error instanceof Error ? error.message : String(error))
    } finally {
      if (owner === imageOwner.current) setImagePending(false)
    }
  }

  const onMaxPhotos = async (value: number) => {
    setMaxPhotosDraft(value)
    maxPhotosDesired.current = value
    if (maxPhotosSaving.current) return
    maxPhotosSaving.current = true
    setMaxPhotosPending(true)
    setRpcError(null)
    try {
      while (maxPhotosDesired.current !== null) {
        const next = maxPhotosDesired.current
        maxPhotosDesired.current = null
        await maxPhotosRpc({value: next})
      }
    } catch (error) {
      maxPhotosDesired.current = null
      setRpcError(error instanceof Error ? error.message : String(error))
    } finally {
      maxPhotosSaving.current = false
      setMaxPhotosPending(false)
      setMaxPhotosDraft(null)
    }
  }

  const dismissLargeImageWarning = () => {
    localStorage.setItem(LARGE_IMAGE_WARNING_KEY, "1")
    setLargeImageWarningDismissed(true)
  }

  const handleStoredPhoto = async (action: "retry" | "discard", imageId: string) => {
    const owner = ++filingOwner.current
    setFilingPending(imageId)
    setRpcError(null)
    try {
      await pendingImageRpc({action, imageId})
    } catch (error) {
      if (owner !== filingOwner.current) return
      setRpcError(error instanceof Error ? error.message : String(error))
    } finally {
      if (owner === filingOwner.current) setFilingPending(null)
    }
  }

  const saveProfile = async (connectionProfile = profile) => {
    setProfilePending(true)
    setRpcError(null)
    try {
      await profileRpc(connectionProfile)
      setEditingConnection(false)
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : String(error))
    } finally {
      setProfilePending(false)
    }
  }

  const sittingLabel = stopping
    ? "Stopping..."
    : starting
      ? "Cancel"
      : "Stop"
  const soulSubmitted = soulReady || pendingNewSoul === soulName.trim()
  const sittingDisabled = stopping || stopPending || modePending || soulPending || snapshot?.soulLoading !== false ||
    (!active && (startPending || modelSaving || maxPhotosPending || !soulSubmitted))
  const showSpinner = starting || reconnecting || stopping
  const manualDisabled = manualPending || visible === "speaking"
  const voiceReady = visible === "listening" || visible === "speaking"

  if (!snapshot) return <main><p className="status">Loading Iris...</p></main>
  if (!snapshot.configured) return (
    <main>
      <h1>Iris setup</h1>
      <p role="status">Install Iris from the OpenAlma launcher.</p>
      {snapshot.lastError ? <p role="alert">{snapshot.lastError}</p> : null}
    </main>
  )
  if (editingConnection) {
    const field = (name: "baseUrl" | "userId" | "deviceSessionId", label: string, type = "text", readOnly = false) => (
      <label>{label}<input type={type} value={profile[name]} disabled={profilePending} readOnly={readOnly}
        onChange={(event) => setProfile({...profile, [name]: event.target.value})} /></label>
    )
    return (
      <main>
        <header><p className="eyebrow">OpenAlma voice</p><h1>Edit Connection</h1></header>
        <section className="soul-control" aria-label="OpenAlma connection setup">
          {field("baseUrl", "OpenAlma address")}
          {field("userId", "Your name", "text", true)}
          {field("deviceSessionId", "Installation ID", "text", true)}
          <button type="button" disabled={profilePending || connectionLocked} onClick={() => void saveProfile()}>
            {profilePending ? "Connecting..." : "Save and connect"}
          </button>
          {connectionLocked ? <p>Wait for settings or stop this sitting before changing its connection.</p> : null}
          <button type="button" disabled={profilePending} onClick={() => setEditingConnection(false)}>Back</button>
          {snapshot.lastError ? <p role="alert">{snapshot.lastError}</p> : null}
          {rpcError ? <p role="alert">{rpcError}</p> : null}
        </section>
      </main>
    )
  }

  return (
    <main>
      <header>
        <p className="eyebrow">OpenAlma voice</p>
        <h1>Iris</h1>
      </header>
      <p className="status" role="status" aria-live="polite">
        {showSpinner ? <span className="spinner" aria-hidden="true" /> : null}
        {statusText(visible, mode, manualPhase, snapshot.soulId, microphoneEnabled)}
        {stopping && stopDeadline !== null ? <span aria-live="off"> {stopSecondsRemaining(stopDeadline, stopNow)}s remaining</span> : null}
      </p>
      {snapshot?.memuAvailable === false ? (
        <p className="memu-status" role="status">
          <img src={memuIcon} alt="" />
          <span>{snapshot.lastError || "Is memU running?"}<br />
            <button type="button" disabled={profilePending || connectionLocked}
              onClick={() => void saveProfile(snapshot.connectionProfile!)}>
              {profilePending ? "Checking..." : "Retry Connection"}
            </button>{" "}
            <button type="button" onClick={editConnection}>Edit Connection</button>
          </span>
        </p>
      ) : null}
      <section className="soul-control" aria-label="Soul selection">
        <label>
          <span>Soul</span>
          <span className="soul-entry">
            <span className="soul-combobox" onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setSoulMenuOpen(false)
            }}>
              <input
                value={soulName}
                disabled={soulLocked || soulPending}
                onFocus={() => setSoulMenuOpen(true)}
                onChange={(event) => {
                  setSoulName(event.target.value)
                  setSoulDirty(true)
                  setConfirmationSoul(null)
                  setPendingNewSoul(null)
                  setShowNewSoulInfo(false)
                  setSoulMenuOpen(true)
                }}
              />
              {soulMenuOpen && snapshot?.souls.length ? (
                <span className="soul-options" role="listbox">
                  {snapshot.souls.map((soul) => (
                    <button key={soul} type="button" role="option" aria-selected={soul === soulName}
                      onClick={() => {
                        setSoulName(soul)
                        setSoulDirty(true)
                        setConfirmationSoul(null)
                        setPendingNewSoul(null)
                        setShowNewSoulInfo(false)
                        setSoulMenuOpen(false)
                        void selectSoul(soul, true)
                      }}>
                      {soul}
                    </button>
                  ))}
                </span>
              ) : null}
            </span>
            <button type="button" aria-label="Use soul"
              title={knownSoul ? "Select existing soul" : "Create new soul"}
              disabled={soulLocked || soulPending || !soulName.trim() || !soulDirty}
              onClick={() => void submitSoul()}>➤</button>
            {soulReady ? <span className="soul-ready" title="Soul exists and is ready">✓</span> : null}
            {pendingNewSoul === soulName.trim() ? (
              <button type="button" className="soul-new" aria-label="New soul information"
                title="New soul will be created" onClick={() => setShowNewSoulInfo((shown) => !shown)}>!</button>
            ) : null}
          </span>
        </label>
        {showNewSoulInfo ? <p className="soul-info">A new soul will be created when you start a call.</p> : null}
        {confirmationSoul ? (
          <div role="alert">
            <p>{confirmationSoul} already exists. Use its existing database?</p>
            <button type="button" disabled={soulPending} onClick={() => void selectSoul(confirmationSoul, true)}>
              Use existing soul
            </button>
          </div>
        ) : null}
        {soulLocked ? <p>Finish this sitting before changing souls.</p> : null}
      </section>
      <section className="controls" aria-label="Voice controls">
        <section className="mode-control" aria-label="Model">
          <span>Model</span>
          <div className="mode-options">
            {LIVE_MODELS.map((model, index) => (
              <button key={model} type="button" aria-pressed={snapshot.modelChoice === model}
                disabled={modelDisabled} onClick={() => void onModel(model)}>
                {index === 0 ? "Live" : "Thinking"}
              </button>
            ))}
          </div>
          <p>{(active || stopping) && snapshot.model
            ? `Using model: ${snapshot.model}`
            : snapshot.modelChoice
              ? `Selected model: ${snapshot.modelChoice}`
              : snapshot.configuredModel
                ? `Using server setting: ${snapshot.configuredModel}`
                : "Using server setting"}</p>
        </section>
        <span>Call</span>
        <div className="sitting-controls">
          {active || stopping ? <button
            type="button"
            className="sitting-button"
            disabled={sittingDisabled}
            onClick={() => void onStop()}
          >
            {sittingLabel}
          </button> : (["audio", "video"] as const).map(kind => <button
            key={kind} type="button" className="sitting-button" disabled={sittingDisabled}
            onClick={() => void onStart(kind)}>{kind === "audio" ? "Audio" : "Video"}</button>)}
          {active || stopping ? <label className="closing-thoughts">
            <input type="checkbox" aria-label="Closing thoughts" checked={closingThoughts}
              disabled={closingThoughtsPending || starting || stopping}
              onChange={event => void onClosingThoughts(event.target.checked)} />
            Closing thoughts
          </label> : null}
        </div>
        {mode === "manual" && voiceReady ? (
          <div className="manual-controls">
            {manualPhase === "idle" ? (
              <button type="button" disabled={manualDisabled || !microphoneEnabled} onClick={() => void onManual("talk")}>
                Talk
              </button>
            ) : null}
            {manualPhase === "recording" ? (
              <button
                type="button"
                className="recording-button"
                disabled={manualDisabled}
                onClick={() => void onManual("done")}
              >
                Done
              </button>
            ) : null}
            {manualPhase === "review" ? (
              <>
                <button type="button" disabled={manualDisabled} onClick={() => void onManual("send")}>
                  Send
                </button>
                <button type="button" disabled={manualDisabled || !microphoneEnabled} onClick={() => void onManual("redo")}>
                  Redo
                </button>
              </>
            ) : null}
            {manualPhase === "submitted" ? <button type="button" disabled>Send</button> : null}
          </div>
        ) : null}
      </section>
      <video ref={vision.videoRef} className="video-preview" muted playsInline
        hidden={!videoCall || !active} aria-label="Phone camera preview" />
      {vision.error ? <p role="alert">{vision.error}</p> : null}
      <details className="photo-controls" key={String(videoCall)} open={!videoCall}>
      <summary>Photos</summary>
      <div className="image-actions">
        {videoCall ? <button type="button" disabled={!vision.ready || !cameraEnabled || !voiceReady || imagePending || stopping}
          onClick={() => void onVideoPhoto()}>Take photo</button> : <label className="image-picker">
          <span>Take photo</span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onClick={() => {pickerGeneration.current = snapshot?.startGeneration ?? null}}
            disabled={!cameraEnabled || !voiceReady || imagePending || stopping}
            onChange={(event) => onImagePicked(event.currentTarget)}
          />
        </label>}
        <label className="image-picker">
          <span>Choose image</span>
          <input
            type="file"
            accept="image/*"
            onClick={() => {pickerGeneration.current = snapshot?.startGeneration ?? null}}
            disabled={!cameraEnabled || !voiceReady || imagePending || stopping}
            onChange={(event) => onImagePicked(event.currentTarget)}
          />
        </label>
      </div>
      </details>
      {pendingPhoto?.previewUrl ? <img className="image-preview" src={pendingPhoto.previewUrl} alt="Selected photo preview" /> : null}
      {pendingPhoto && shouldWarnLargeImage(pendingPhoto.file.size, largeImageWarningDismissed) ? (
        <div role="alert">
          <p>This photo is over 1 MB and may take longer or cost more to process.</p>
          <label>
            <input type="checkbox" onChange={(event) => event.target.checked && dismissLargeImageWarning()} />
            Don't warn again
          </label>
        </div>
      ) : null}
      {pendingPhoto && !photoRetryPending ? (
        <div className="image-review">
          <button type="button" disabled={!cameraEnabled || imagePending || !voiceReady} onClick={() => void submitPhoto(pendingPhoto)}>
            {imagePending ? "Sending..." : imageStatus ? "Retry" : "Send"}
          </button>
          <button type="button" disabled={imagePending} onClick={() => discardPhoto()}>Retake</button>
        </div>
      ) : null}
      {imageStatus ? <p role="status">{imageStatus}</p> : null}
      {snapshot?.photoCaptions?.length ? (
        <details className="photo-captions">
          <summary>Photo captions</summary>
          <ol>
            {snapshot.photoCaptions.map(({imageId, caption, durable, receivedAt}) => (
              <li key={`${imageId}:${caption}`}>
                <time dateTime={new Date(receivedAt).toISOString()} title="Received by Iris">
                  {new Date(receivedAt).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})}
                </time>
                {durable ? <span className="soul-ready" aria-label="Accepted by memU" title="Accepted by memU">✓</span> : null}
                <p>{caption}</p>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {photoRetryPending ? (
        <div>
          <p role="status">{visible === "idle" || visible === "error"
            ? "Start Iris to retry or discard the pending photo"
            : PHOTO_RETRY_MESSAGE}</p>
          {snapshot?.pendingPhotoIds.map(imageId => (
            <div className="image-review" key={imageId}>
              <span>{imageId}</span>
              <button type="button" disabled={filingPending !== null || imagePending || stopping || !voiceReady} onClick={() => void handleStoredPhoto("retry", imageId)}>Retry</button>
              <button type="button" disabled={filingPending !== null || imagePending || stopping || !voiceReady} onClick={() => void handleStoredPhoto("discard", imageId)}>Discard</button>
            </div>
          ))}
        </div>
      ) : null}
      {snapshot?.failedPhotos?.length ? (
        <section aria-label="Failed photo filings">
          {snapshot.failedPhotos.map((imageId, index) => (
            <div className="image-review" key={imageId}>
              <span>Photo {index + 1}: filing failed.</span>
              <button type="button" aria-label={`Retry failed photo ${index + 1}`}
                disabled={filingPending !== null || stopping}
                onClick={() => void handleStoredPhoto("retry", imageId)}>Retry</button>
              <button type="button" aria-label={`Discard failed photo ${index + 1}`}
                disabled={filingPending !== null || stopping}
                onClick={() => void handleStoredPhoto("discard", imageId)}>Discard</button>
            </div>
          ))}
        </section>
      ) : null}
      {snapshot?.memuAvailable !== false && snapshot?.lastError && snapshot.lastError !== PHOTO_RETRY_MESSAGE
        ? <p role="alert">{snapshot.lastError}</p> : null}
      {snapshot?.durationWarning ? <p role="status">Session duration warning</p> : null}
      {snapshot?.usageTotalTokens !== null && snapshot?.usageTotalTokens !== undefined ? (
        <p>Provider tokens: {snapshot.usageTotalTokens.toLocaleString()}</p>
      ) : null}
      {rpcError ? <p role="alert">{rpcError}</p> : null}
      <section id="iris-settings" aria-label="Iris settings" hidden={!settingsOpen}>
        <h2>Settings</h2>
      <section className="mode-control" aria-label="Speech mode">
        <span>Speech mode</span>
        <div className="mode-options">
          <button type="button" aria-pressed={mode === "continuous"} disabled={modeDisabled}
            onClick={() => void onMode("continuous")}>Continuous</button>
          <button type="button" aria-pressed={mode === "manual"} disabled={modeDisabled}
            onClick={() => void onMode("manual")}>Manual</button>
        </div>
      </section>
      <label className="photo-allowance">
        Maximum memorized photos:
        <output>{maxPhotosDraft ?? snapshot.maxMemorizedPhotos} in 5 min, {(maxPhotosDraft ?? snapshot.maxMemorizedPhotos) * 2} in 15 min, {(maxPhotosDraft ?? snapshot.maxMemorizedPhotos) * 3} in 45 min</output>
        <span className="allowance-slider">Fewer <input type="range" min="1" max="5" step="1"
          aria-label="Maximum memorized photos" value={maxPhotosDraft ?? snapshot.maxMemorizedPhotos}
          disabled={starting || stopping} onChange={event => void onMaxPhotos(Number(event.target.value))} /> More</span>
        {active ? <small>Changes apply to the next call.</small> : null}
      </label>
      <label className="preview-control">
        <input
          type="checkbox"
          checked={microphoneEnabled}
          disabled={capabilitiesPending || stopping}
          onChange={(event) => void onCapability("microphoneEnabled", event.target.checked)}
        />
        Microphone enabled
      </label>
      <label className="preview-control">
        <input
          type="checkbox"
          checked={cameraEnabled}
          disabled={capabilitiesPending || stopping}
          onChange={(event) => void onCapability("cameraEnabled", event.target.checked)}
        />
        Camera enabled
      </label>
      <label className="preview-control">
        <input type="checkbox" checked={previewImages} onChange={(event) => setPreviewImages(event.target.checked)} />
        Preview before send
      </label>
      <label className="preview-control">
        <input
          type="checkbox"
          checked={speakPhotoDescriptions}
          onChange={(event) => setSpeakPhotoDescriptions(event.target.checked)}
        />
        Speak photo descriptions
      </label>
        <button type="button" onClick={editConnection}>Edit Connection</button>
        <small className="iris-version">Iris {manifest.version}</small>
      </section>
      <button type="button" className="settings-toggle" aria-label="Settings" aria-controls="iris-settings"
        aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}>&#9881; Settings</button>
    </main>
  )
}
