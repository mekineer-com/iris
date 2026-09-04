import {afterEach, describe, expect, test} from "bun:test"

import {readOpenAlmaConfig} from "./openAlmaConfig"

const KEYS = [
  "MENTRA_PUBLIC_OPENALMA_BASE_URL",
  "MENTRA_PUBLIC_OPENALMA_BEARER",
  "MENTRA_PUBLIC_OPENALMA_USER_ID",
  "MENTRA_PUBLIC_OPENALMA_SOUL_ID",
  "MENTRA_PUBLIC_OPENALMA_DEVICE_SESSION_ID",
] as const
const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const key of KEYS) {
    const value = original[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("readOpenAlmaConfig", () => {
  test("normalizes one valid personal-device configuration", () => {
    process.env.MENTRA_PUBLIC_OPENALMA_BASE_URL = "http://10.77.0.1///"
    process.env.MENTRA_PUBLIC_OPENALMA_BEARER = "fictional"
    process.env.MENTRA_PUBLIC_OPENALMA_USER_ID = "Test User"
    process.env.MENTRA_PUBLIC_OPENALMA_SOUL_ID = "Test Soul"
    process.env.MENTRA_PUBLIC_OPENALMA_DEVICE_SESSION_ID = "test-phone"
    expect(readOpenAlmaConfig()).toEqual({
      baseUrl: "http://10.77.0.1",
      bearer: "fictional",
      userId: "Test User",
      soulId: "Test Soul",
      deviceSessionId: "test-phone",
      packageName: "com.openalma.mentra",
      version: "0.1.1",
    })
  })

  test("does not require the URL global missing from the Mentra runtime", () => {
    process.env.MENTRA_PUBLIC_OPENALMA_BASE_URL = "http://10.77.0.1:8081"
    process.env.MENTRA_PUBLIC_OPENALMA_BEARER = "fictional"
    process.env.MENTRA_PUBLIC_OPENALMA_USER_ID = "Test User"
    process.env.MENTRA_PUBLIC_OPENALMA_SOUL_ID = "Test Soul"
    process.env.MENTRA_PUBLIC_OPENALMA_DEVICE_SESSION_ID = "test-phone"
    const urlConstructor = globalThis.URL
    Reflect.deleteProperty(globalThis, "URL")
    try {
      expect(readOpenAlmaConfig().baseUrl).toBe("http://10.77.0.1:8081")
    } finally {
      globalThis.URL = urlConstructor
    }
  })

  test("fails before transport work when required configuration is missing", () => {
    for (const key of KEYS) delete process.env[key]
    expect(() => readOpenAlmaConfig()).toThrow("MENTRA_PUBLIC_OPENALMA_BASE_URL is not configured")
  })
})
