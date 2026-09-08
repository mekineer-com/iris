import type {OpenAlmaConfig} from "./openAlmaConfig"
import {timeoutSignal} from "./timeoutSignal"

export async function reportInstallation(
  config: OpenAlmaConfig,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchFn(`${config.baseUrl}/integration/mentra/installation/seen`, {
    method: "POST",
    signal: timeoutSignal(10_000),
    headers: {
      Authorization: `Bearer ${config.bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      user_id: config.userId,
      soul_id: config.soulId,
      device_session_id: config.deviceSessionId,
      package_name: config.packageName,
      version: config.version,
    }),
  })
  if (!response.ok) throw new Error(`Installation report failed (${response.status})`)
}
