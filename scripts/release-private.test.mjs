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
  test("binds the CLI directly to the configured address and fixed port", () => {
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

  test("accepts configured addresses without an interface or connection key and validates settings", () => {
    const env = {
      MENTRA_PUBLIC_OPENALMA_BASE_URL: "http://10.77.0.1",
      MENTRA_PUBLIC_OPENALMA_USER_ID: "Test User",
      MENTRA_PUBLIC_OPENALMA_DEVICE_SESSION_ID: "test-phone",
      MENTRA_RELEASE_HOST_PACKAGE: "com.mentra.mentra",
    }
    for (const host of ["10.77.0.1", "100.64.0.2", "iris.example", "192.0.2.1", "[fd00::1]"]) {
      expect(assertPrivateReleaseConfig({...env, MENTRA_PUBLIC_OPENALMA_BASE_URL: `http://${host}:8099`})).toBe(host)
      expect(releaseArgs(host).slice(0, 5)).toEqual(["release", "--host", host, "--port", "6789"])
    }
    expect(() => assertPrivateReleaseConfig({...env, MENTRA_PUBLIC_OPENALMA_USER_ID: ""})).toThrow(
      "MENTRA_PUBLIC_OPENALMA_USER_ID",
    )
    expect(() => assertPrivateReleaseConfig({...env, MENTRA_RELEASE_HOST_PACKAGE: "unknown"})).toThrow(
      "Unknown Mentra app installation",
    )
    for (const baseUrl of ["invalid", "ftp://iris.example", "http://user@iris.example", "http://iris.example?q=1",
      "http://iris.example#fragment", "http://iris.example:65536", "http://iris.example:bad"]) {
      expect(() => assertPrivateReleaseConfig({...env, MENTRA_PUBLIC_OPENALMA_BASE_URL: baseUrl})).toThrow()
    }
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
