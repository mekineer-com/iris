import {useState} from "react"
import {useRpc} from "@mentra/miniapp/ui"

import type {Channels} from "../../shared/channels"
import type {SessionMode} from "../../shared/types"
import {useChannel} from "../hooks/useChannel"

export default function SessionPage() {
  const snapshot = useChannel("openalma:update")
  const startRpc = useRpc<Channels, "openalma:start">("openalma:start")
  const stopRpc = useRpc<Channels, "openalma:stop">("openalma:stop")
  const modeRpc = useRpc<Channels, "openalma:set-mode">("openalma:set-mode")
  const [busy, setBusy] = useState(false)
  const [rpcError, setRpcError] = useState<string | null>(null)

  const connection = snapshot?.connection ?? "idle"
  const mode = snapshot?.mode ?? "continuous"
  const blocked = busy || connection === "starting" || connection === "stopping"
  const active = connection === "starting" || connection === "listening" || connection === "speaking"

  const onToggle = async () => {
    setRpcError(null)
    setBusy(true)
    try {
      if (active) await stopRpc({})
      else await startRpc({mode})
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const onMode = async (next: SessionMode) => {
    setRpcError(null)
    try {
      await modeRpc({mode: next})
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <main>
      <h1>OpenAlma</h1>
      <p>Connection: {connection}</p>
      <label>
        Mode{" "}
        <select
          value={mode}
          disabled={blocked}
          onChange={(event) => void onMode(event.target.value as SessionMode)}
        >
          <option value="continuous">Continuous</option>
          <option value="manual">Manual</option>
        </select>
      </label>
      <p>
        <button type="button" disabled={blocked} onClick={() => void onToggle()}>
          {active ? "Stop" : "Start"}
        </button>
      </p>
      {snapshot?.lastError ? <p role="alert">{snapshot.lastError}</p> : null}
      {rpcError ? <p role="alert">{rpcError}</p> : null}
    </main>
  )
}
