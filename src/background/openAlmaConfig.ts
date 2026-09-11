import manifest from "../../miniapp.json"
import type {OpenAlmaProfile} from "../shared/types"

export const OPENALMA_PROFILE_KEY = "openalma.connection-profile"
export const OPENALMA_PROFILE_CLEARED_KEY = "openalma.connection-profile-cleared"

export type OpenAlmaConfig = OpenAlmaProfile & {
  packageName: string
  version: string
}

function required(name: keyof OpenAlmaProfile, value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : ""
  if (!normalized) throw new Error(`${name} is not configured`)
  return normalized
}

export function parseOpenAlmaProfile(value: unknown): OpenAlmaConfig {
  const profile = typeof value === "string" ? JSON.parse(value) as unknown : value
  if (!profile || typeof profile !== "object") throw new Error("OpenAlma profile is invalid")
  const raw = profile as Record<string, unknown>
  const baseUrl = required("baseUrl", raw.baseUrl).replace(/\/+$/, "")
  if (!/^https?:\/\/[^\s@?#]+$/.test(baseUrl)) {
    throw new Error("baseUrl must be an http or https URL without credentials, query, or fragment")
  }
  const deviceSessionId = required("deviceSessionId", raw.deviceSessionId)
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(deviceSessionId)) {
    throw new Error("deviceSessionId has an invalid format")
  }
  return {
    baseUrl,
    bearer: required("bearer", raw.bearer),
    userId: required("userId", raw.userId),
    soulId: required("soulId", raw.soulId),
    deviceSessionId,
    packageName: manifest.packageName,
    version: manifest.version,
  }
}

export function serializeOpenAlmaProfile(config: OpenAlmaConfig): string {
  const {baseUrl, bearer, userId, soulId, deviceSessionId} = config
  return JSON.stringify({baseUrl, bearer, userId, soulId, deviceSessionId})
}
