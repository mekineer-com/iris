import type {OpenAlmaConfig} from "./openAlmaConfig"
import {timeoutSignal} from "./timeoutSignal"

export const OPENALMA_HOST_KEY = "openalma.host"
export type InstallationHost = {host_package: "com.mentra.mentra.openalma"; host_version: string; deviceSessionId: string}

export function installationHost(value: string | null): InstallationHost | undefined {
  if (value === null) return undefined
  const host = JSON.parse(value) as Partial<InstallationHost>
  if (!host || typeof host !== "object" || host.host_package !== "com.mentra.mentra.openalma" ||
      typeof host.host_version !== "string" || !host.host_version.trim() || host.host_version.length > 64 ||
      typeof host.deviceSessionId !== "string" || !host.deviceSessionId) {
    throw new Error("Invalid Mentra host marker")
  }
  return {host_package: host.host_package, host_version: host.host_version.trim(), deviceSessionId: host.deviceSessionId}
}

export async function reportInstallation(
  config: OpenAlmaConfig,
  fetchFn: typeof fetch = fetch,
  host?: InstallationHost,
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
      soul_id: config.soulId.trim() || null,
      device_session_id: config.deviceSessionId,
      package_name: config.packageName,
      version: config.version,
      ...(host ? {host_package: host.host_package, host_version: host.host_version} : {}),
    }),
  })
  if (!response.ok) throw new Error(`Installation report failed (${response.status})`)
}
