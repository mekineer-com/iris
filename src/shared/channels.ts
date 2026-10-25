import type {Rpc} from "@mentra/miniapp/ui"
import type {CallMode, CatchUpResult, FrameIntakeResult, ImageTime, LiveModel, ManualAction, OpenAlmaProfile, PassiveFrame, SessionMode, SessionSnapshot} from "./types"

export type ImageReferenceRequest = {startGeneration: number; time: ImageTime}
export type FrameRequest = PassiveFrame & {startGeneration: number}
export type GalleryPhotoRequest = {
  data: string
  mimeType: "image/jpeg" | "image/png"
  filename: string
  creationTime: number
}
export type GalleryPhotoResult = {success: boolean; error?: string}

export type ImageRequest = {
  imageId: string
  mimeType: "image/jpeg" | "image/png"
  data: string
  speakDescription?: boolean
  time?: ImageTime
}

export type SelectSoulResult =
  | {soulId: string; created: boolean}
  | {soulId: string; confirmationRequired: true}

export interface Channels {
  "openalma:visibility": {visible: boolean}
  "openalma:update": SessionSnapshot
  "openalma:set-profile": Rpc<OpenAlmaProfile, {ok: true}>
  "openalma:start": Rpc<{mode: SessionMode; callMode?: CallMode}, {ok: true}>
  "openalma:stop": Rpc<Record<string, never>, {ok: true}>
  "openalma:set-closing-thoughts": Rpc<{enabled: boolean}, {ok: true}>
  "openalma:set-soul": Rpc<{soulId: string; useExisting: boolean}, SelectSoulResult>
  "openalma:set-mode": Rpc<{mode: SessionMode}, {ok: true}>
  "openalma:set-model": Rpc<{model: LiveModel}, {ok: true}>
  "openalma:set-max-memorized-photos": Rpc<{value: number}, {ok: true}>
  "openalma:set-capabilities": Rpc<{
    microphoneEnabled?: boolean
    cameraEnabled?: boolean
  }, {ok: true}>
  "openalma:manual-action": Rpc<{action: ManualAction}, {ok: true}>
  "openalma:image": Rpc<ImageRequest, {ok: true} | {ok: false; conflict: true}>
  "openalma:save-photo": Rpc<GalleryPhotoRequest, GalleryPhotoResult>
  "openalma:reserve-image": Rpc<ImageReferenceRequest, {startGeneration: number; imageId: string; reservationSequence: number}>
  "openalma:frame": Rpc<FrameRequest, FrameIntakeResult>
  "openalma:frames": Rpc<{startGeneration: number; imageIds: string[]}, {frames: Array<Pick<PassiveFrame, "imageId" | "mimeType" | "data" | "time">>}>
  "openalma:catch-up-rendered": Rpc<CatchUpResult, void>
  "openalma:pending-image": Rpc<{action: "retry" | "discard"; imageId: string}, {ok: true}>
}

declare global {
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
