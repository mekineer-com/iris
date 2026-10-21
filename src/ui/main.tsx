import {createRoot} from "react-dom/client"
import {MentraProvider} from "@mentra/miniapp/ui"
import "../shared/channels"
import {installUiBridge} from "../shared/hostBridge"

import App from "./App"
import "../index.css"

installUiBridge()

const root = document.getElementById("root")
if (!root) throw new Error("Root element not found")
createRoot(root).render(
  <MentraProvider>
    <App />
  </MentraProvider>,
)

mentra.ready()
