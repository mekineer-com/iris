export type OpenAlmaConfig = {
  baseUrl: string
  bearer: string
  userId: string
  soulId: string
  deviceSessionId: string
}

function required(name: string, value: string | undefined): string {
  const normalized = value?.trim() ?? ""
  if (!normalized) throw new Error(`${name} is not configured`)
  return normalized
}

export function readOpenAlmaConfig(): OpenAlmaConfig {
  const rawBaseUrl = required("MENTRA_PUBLIC_OPENALMA_BASE_URL", process.env.MENTRA_PUBLIC_OPENALMA_BASE_URL)
  const url = new URL(rawBaseUrl)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MENTRA_PUBLIC_OPENALMA_BASE_URL must use http or https")
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("MENTRA_PUBLIC_OPENALMA_BASE_URL must not contain credentials, query, or fragment")
  }

  const deviceSessionId = required(
    "MENTRA_PUBLIC_OPENALMA_DEVICE_SESSION_ID",
    process.env.MENTRA_PUBLIC_OPENALMA_DEVICE_SESSION_ID,
  )
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(deviceSessionId)) {
    throw new Error("MENTRA_PUBLIC_OPENALMA_DEVICE_SESSION_ID has an invalid format")
  }

  return {
    baseUrl: rawBaseUrl.replace(/\/+$/, ""),
    bearer: required("MENTRA_PUBLIC_OPENALMA_BEARER", process.env.MENTRA_PUBLIC_OPENALMA_BEARER),
    userId: required("MENTRA_PUBLIC_OPENALMA_USER_ID", process.env.MENTRA_PUBLIC_OPENALMA_USER_ID),
    soulId: required("MENTRA_PUBLIC_OPENALMA_SOUL_ID", process.env.MENTRA_PUBLIC_OPENALMA_SOUL_ID),
    deviceSessionId,
  }
}
