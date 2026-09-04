import {registerMiniapp} from "@mentra/miniapp/background"

import {SessionController} from "./SessionController"
import {reportInstallation} from "./installation"
import {readOpenAlmaConfig} from "./openAlmaConfig"

registerMiniapp((session) => {
  const controller = new SessionController(session)
  controller.start()
  if (process.env.NODE_ENV !== "production") return
  try {
    const config = readOpenAlmaConfig()
    void reportInstallation(config).catch((error) => {
      console.error("[OpenAlma] installation report failed:", error)
      controller.reportInstallationError()
    })
  } catch (error) {
    console.error("[OpenAlma] installation report failed:", error)
    controller.reportInstallationError()
  }
})
