import type {Rpc} from "@mentra/miniapp/ui"
import type {ManualAction, SessionMode, SessionSnapshot} from "./types"

export type ImageRequest = {
  imageId: string
  mimeType: "image/jpeg" | "image/png"
  data: string
}

export interface Channels {
  "openalma:update": SessionSnapshot
  "openalma:start": Rpc<{mode: SessionMode}, {ok: true}>
  "openalma:stop": Rpc<Record<string, never>, {ok: true}>
  "openalma:set-mode": Rpc<{mode: SessionMode}, {ok: true}>
  "openalma:manual-action": Rpc<{action: ManualAction}, {ok: true}>
  "openalma:image": Rpc<ImageRequest, {ok: true}>
}

declare global {
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
