import {registerMiniapp} from "@mentra/miniapp/background"

import {SessionController} from "./SessionController"

registerMiniapp((session) => {
  new SessionController(session).start()
})
