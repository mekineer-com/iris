import {describe, expect, test} from "bun:test"
import {mkdtempSync, readFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

import {
  assertPrivateReleaseConfig,
  findReleaseUri,
  installationCompletesOffer,
  releaseArgs,
  releaseProfile,
  writeReleaseStatus,
} from "./release-private.mjs"

describe("private release URI", () => {
  test("binds the CLI directly to the fixed WireGuard address and port", () => {
    const uri =
      "miniapp://release?url=http%3A%2F%2F10.77.0.1%3A6789&package=com.openalma.mentra&version=0.1.0&name=OpenAlma%20Iris"
    const release = new URL(findReleaseUri(`before\n${uri}\nafter`))

    expect(releaseArgs("10.77.0.1")).toEqual(["release", "--host", "10.77.0.1", "--port", "6789", "--no-cache"])
    expect(releaseArgs("10.77.0.1", "/tmp/iris.zip")).toEqual([
      "release", "--host", "10.77.0.1", "--port", "6789", "--no-cache", "--bundle", "/tmp/iris.zip",
    ])
    expect(release.searchParams.get("url")).toBe("http://10.77.0.1:6789")
    expect(release.searchParams.get("package")).toBe("com.openalma.mentra")
    expect(release.searchParams.get("version")).toBe("0.1.0")
  })

  test("rejects a non-WireGuard listener or missing build setting", () => {
    const env = {
      MENTRA_PUBLIC_OPENALMA_BASE_URL: "http://10.77.0.1",
      MENTRA_PUBLIC_OPENALMA_BEARER: "fictional",
      MENTRA_PUBLIC_OPENALMA_USER_ID: "Test User",
      MENTRA_PUBLIC_OPENALMA_DEVICE_SESSION_ID: "test-phone",
      MENTRA_RELEASE_HOST_PACKAGE: "com.mentra.mentra",
    }
    const interfaces = {rdp: [{family: "IPv4", address: "10.77.0.1"}]}

    expect(() => assertPrivateReleaseConfig("10.77.0.1", env, interfaces, ["rdp"])).not.toThrow()
    expect(() => assertPrivateReleaseConfig("161.132.51.34", env, interfaces, ["rdp"])).toThrow(
      "not a local WireGuard address",
    )
    expect(() => assertPrivateReleaseConfig("10.77.0.1", {...env, MENTRA_PUBLIC_OPENALMA_BEARER: ""}, interfaces, ["rdp"])).toThrow(
      "MENTRA_PUBLIC_OPENALMA_BEARER",
    )
    expect(JSON.parse(releaseProfile(env))).toEqual({
      baseUrl: "http://10.77.0.1",
      userId: "Test User",
      deviceSessionId: "test-phone",
    })
  })

  test("writes installer status atomically", () => {
    const path = join(mkdtempSync(join(tmpdir(), "iris-release-test-")), "build", "status.json")
    writeReleaseStatus(path, {package_name: "com.openalma.mentra", version: "0.1.0"})
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      package_name: "com.openalma.mentra",
      version: "0.1.0",
    })
  })

  test("completes only a fresh exact stock installation report", () => {
    const offer = {
      deviceSessionId: "test-phone",
      packageName: "com.openalma.mentra",
      version: "0.1.1",
      startedAt: 100,
    }
    const status = {
      installed_device: "test-phone",
      installed_package: "com.openalma.mentra",
      installed_version: "0.1.1",
      installed_seen_at: 101,
    }
    expect(installationCompletesOffer(status, offer)).toBe(true)
    expect(installationCompletesOffer({...status, installed_device: "other-phone"}, offer)).toBe(false)
    expect(installationCompletesOffer({...status, installed_seen_at: 100}, offer)).toBe(false)
    expect(installationCompletesOffer({...status, host: {host_package: "com.mentra.mentra.openalma"}}, offer)).toBe(false)
  })
})
