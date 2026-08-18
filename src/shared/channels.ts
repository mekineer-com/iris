import type {Rpc} from "@mentra/miniapp/ui"
import type {SessionMode, SessionSnapshot} from "./types"

export interface Channels {
  "openalma:update": SessionSnapshot
  "openalma:start": Rpc<{mode: SessionMode}, {ok: true}>
  "openalma:stop": Rpc<Record<string, never>, {ok: true}>
  "openalma:set-mode": Rpc<{mode: SessionMode}, {ok: true}>
}

declare global {
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
