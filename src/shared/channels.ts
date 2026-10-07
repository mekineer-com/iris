import type {Rpc} from "@mentra/miniapp/ui"
import type {ManualAction, OpenAlmaProfile, SessionMode, SessionSnapshot} from "./types"

export type ImageRequest = {
  imageId: string
  mimeType: "image/jpeg" | "image/png"
  data: string
  speakDescription?: boolean
}

export type SelectSoulResult =
  | {soulId: string; created: boolean}
  | {soulId: string; confirmationRequired: true}

export interface Channels {
  "openalma:update": SessionSnapshot
  "openalma:set-profile": Rpc<OpenAlmaProfile, {ok: true}>
  "openalma:start": Rpc<{mode: SessionMode}, {ok: true}>
  "openalma:stop": Rpc<Record<string, never>, {ok: true}>
  "openalma:set-soul": Rpc<{soulId: string; useExisting: boolean}, SelectSoulResult>
  "openalma:set-mode": Rpc<{mode: SessionMode}, {ok: true}>
  "openalma:set-capabilities": Rpc<{
    microphoneEnabled?: boolean
    cameraEnabled?: boolean
  }, {ok: true}>
  "openalma:manual-action": Rpc<{action: ManualAction}, {ok: true}>
  "openalma:image": Rpc<ImageRequest, {ok: true}>
  "openalma:pending-image": Rpc<{action: "retry" | "discard"}, {ok: true}>
}

declare global {
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
