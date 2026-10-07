import {registerMiniapp} from "@mentra/miniapp/background"

import {SessionController} from "./SessionController"

registerMiniapp((session) => {
  const controller = new SessionController(session, {
    installationDefaults: (globalThis as typeof globalThis & {__OPENALMA_INSTALL_DEFAULTS__?: unknown})
      .__OPENALMA_INSTALL_DEFAULTS__,
  })
  controller.start()
})
