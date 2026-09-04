import {describe, expect, test} from "bun:test"

import {assertPrivateReleaseConfig, findReleaseUri, releaseArgs} from "./release-private.mjs"

describe("private release URI", () => {
  test("binds the CLI directly to the fixed WireGuard address and port", () => {
    const uri =
      "miniapp://release?url=http%3A%2F%2F10.77.0.1%3A6789&package=com.openalma.mentra&version=0.1.0&name=OpenAlma"
    const release = new URL(findReleaseUri(`before\n${uri}\nafter`))

    expect(releaseArgs("10.77.0.1")).toEqual(["release", "--host", "10.77.0.1", "--port", "6789"])
    expect(release.searchParams.get("url")).toBe("http://10.77.0.1:6789")
    expect(release.searchParams.get("package")).toBe("com.openalma.mentra")
    expect(release.searchParams.get("version")).toBe("0.1.0")
  })

  test("rejects a non-WireGuard listener or missing build setting", () => {
    const env = {
      MENTRA_PUBLIC_OPENALMA_BASE_URL: "http://10.77.0.1",
      MENTRA_PUBLIC_OPENALMA_BEARER: "fictional",
      MENTRA_PUBLIC_OPENALMA_USER_ID: "Test User",
      MENTRA_PUBLIC_OPENALMA_SOUL_ID: "Test Soul",
      MENTRA_PUBLIC_OPENALMA_DEVICE_SESSION_ID: "test-phone",
    }
    const interfaces = {rdp: [{family: "IPv4", address: "10.77.0.1"}]}

    expect(() => assertPrivateReleaseConfig("10.77.0.1", env, interfaces, ["rdp"])).not.toThrow()
    expect(() => assertPrivateReleaseConfig("161.132.51.34", env, interfaces, ["rdp"])).toThrow(
      "not a local WireGuard address",
    )
    expect(() => assertPrivateReleaseConfig("10.77.0.1", {...env, MENTRA_PUBLIC_OPENALMA_BEARER: ""}, interfaces, ["rdp"])).toThrow(
      "MENTRA_PUBLIC_OPENALMA_BEARER",
    )
  })
})
