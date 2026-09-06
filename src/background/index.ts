import {registerMiniapp} from "@mentra/miniapp/background"

import {SessionController} from "./SessionController"

registerMiniapp((session) => {
  const controller = new SessionController(session)
  controller.start()
})
