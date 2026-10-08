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
      MENTRA_PUBLIC_OPENALMA_INSTALLATION_TICKET: "test-ticket",
      MENTRA_RELEASE_HOST_PACKAGE: "com.mentra.mentra",
    }
    for (const host of ["10.77.0.1", "100.64.0.2", "iris.example", "192.0.2.1", "[fd00::1]"]) {
      expect(assertPrivateReleaseConfig({...env, MENTRA_PUBLIC_OPENALMA_BASE_URL: `http://${host}:8099`})).toBe(host)
      expect(releaseArgs(host).slice(0, 5)).toEqual(["release", "--host", host, "--port", "6789"])
    }
    for (const host of ["localhost", "LOCALHOST.", "phone.localhost", "127.0.0.1", "127.8.9.10",
      "127.1", "2130706433", "[::1]", "[0:0:0:0:0:0:0:1]", "[::ffff:127.0.0.1]"]) {
      expect(() => assertPrivateReleaseConfig({...env, MENTRA_PUBLIC_OPENALMA_BASE_URL: `http://${host}:8099`}))
        .toThrow("phone-reachable")
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
      installationTicket: "test-ticket",
    })
    expect(assertPrivateReleaseConfig({...env, MENTRA_PUBLIC_OPENALMA_DEVICE_SESSION_ID: ""})).toBe("10.77.0.1")
    expect(() => assertPrivateReleaseConfig({...env, MENTRA_PUBLIC_OPENALMA_INSTALLATION_TICKET: ""}))
      .toThrow("MENTRA_PUBLIC_OPENALMA_INSTALLATION_TICKET")
    const fork = {...env, MENTRA_RELEASE_HOST_PACKAGE: "com.mentra.mentra.openalma"}
    expect(JSON.parse(releaseProfile(fork))).toEqual({
      baseUrl: "http://10.77.0.1", userId: "Test User", deviceSessionId: "test-phone",
    })
    expect(assertPrivateReleaseConfig({...fork, MENTRA_PUBLIC_OPENALMA_INSTALLATION_TICKET: ""})).toBe("10.77.0.1")
    expect(() => assertPrivateReleaseConfig({...fork, MENTRA_PUBLIC_OPENALMA_DEVICE_SESSION_ID: ""}))
      .toThrow("MENTRA_PUBLIC_OPENALMA_DEVICE_SESSION_ID")
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
      installationTicket: "test-ticket",
      packageName: "com.openalma.mentra",
      version: "0.1.1",
      startedAt: 100,
    }
    const record = {
      device_session_id: "permanent-phone",
      installation_ticket: "test-ticket",
      package_name: "com.openalma.mentra",
      version: "0.1.1",
      seen_at: 101,
    }
    const status = {installations: [record]}
    expect(installationCompletesOffer(status, offer)).toBe(true)
    for (const override of [
      {installation_ticket: "other-ticket"}, {installation_ticket: undefined},
      {seen_at: 100}, {seen_at: undefined}, {package_name: "wrong-package"}, {version: "0.1.0"},
      {host: {host_package: "com.mentra.mentra.openalma"}},
    ]) {
      expect(installationCompletesOffer({installations: [{...record, ...override}]}, offer)).toBe(false)
    }
    expect(installationCompletesOffer({}, offer)).toBe(false)
    expect(installationCompletesOffer(status, {...offer, installationTicket: ""})).toBe(false)
    expect(installationCompletesOffer({installations: [
      {...record, installation_ticket: "other-ticket"}, record,
    ]}, offer)).toBe(true)
  })
})
