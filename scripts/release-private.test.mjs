import {describe, expect, test} from "bun:test"
import {spawn, spawnSync} from "node:child_process"
import {once} from "node:events"
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {fileURLToPath} from "node:url"
import JSZip from "jszip"

import {
  assertPrivateReleaseConfig,
  findReleaseUri,
  installationCompletesOffer,
  releaseArgs,
  releaseProfile,
  writeReleaseStatus,
} from "./release-private.mjs"

describe("private release URI", () => {
  test("the pinned CLI packs nested files and dotfiles without external zip", async () => {
    const root = mkdtempSync(join(tmpdir(), "iris-pack-test-"))
    try {
      const manifest = JSON.parse(readFileSync(new URL("../miniapp.json", import.meta.url), "utf8"))
      writeFileSync(join(root, "miniapp.json"), JSON.stringify(manifest))
      mkdirSync(join(root, "dist", "background"), {recursive: true})
      mkdirSync(join(root, "dist", "ui"), {recursive: true})
      writeFileSync(join(root, "dist", manifest.entry.background), "fixture background")
      writeFileSync(join(root, "dist", manifest.entry.ui), "fixture UI")
      writeFileSync(join(root, "dist", "ui", ".hidden"), "fixture dotfile")
      const packUrl = new URL("../node_modules/@mentra/miniapp-cli/src/pack.ts", import.meta.url).href
      const script = `import {pack} from ${JSON.stringify(packUrl)}; await pack({cwd:${JSON.stringify(root)}, silent:true})`
      const result = spawnSync(process.execPath, ["-e", script], {
        env: {...process.env, PATH: ""}, encoding: "utf8", timeout: 5000,
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      const archive = await JSZip.loadAsync(readFileSync(join(root, "build", `${manifest.packageName}-${manifest.version}.zip`)))
      expect(JSON.parse(await archive.file("miniapp.json").async("string"))).toEqual(manifest)
      expect(await archive.file(manifest.entry.background).async("string")).toBe("fixture background")
      expect(await archive.file(manifest.entry.ui).async("string")).toBe("fixture UI")
      expect(await archive.file("ui/.hidden").async("string")).toBe("fixture dotfile")
    } finally {
      rmSync(root, {recursive: true, force: true})
    }
  })

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
    for (const host of ["10.77.0.1", "172.16.0.1", "192.168.1.2", "100.64.0.2", "iris.example",
      "127.example.com", "127.example.com.", "phone.localhost.example", "192.0.2.1",
      "[fd00::1]", "[fe80::1]", "[::ffff:a4d:1]"]) {
      for (const baseUrl of [`http://${host}:8099`, `https://${host}:8099/`]) {
        expect(assertPrivateReleaseConfig({...env, MENTRA_PUBLIC_OPENALMA_BASE_URL: baseUrl})).toBe(host)
      }
      expect(releaseArgs(host).slice(0, 5)).toEqual(["release", "--host", host, "--port", "6789"])
    }
    for (const [host, normalized] of [
      ["0x0a4d0001", "10.77.0.1"], ["012.0115.0.1", "10.77.0.1"],
      ["[fd00:0:0:0:0:0:0:1]", "[fd00::1]"], ["[::ffff:10.77.0.1]", "[::ffff:a4d:1]"],
    ]) {
      expect(assertPrivateReleaseConfig({...env, MENTRA_PUBLIC_OPENALMA_BASE_URL: `http://${host}:8099/`}))
        .toBe(normalized)
    }
    for (const host of ["localhost", "LOCALHOST.", "phone.localhost", "127.0.0.1", "127.8.9.10",
      "phone.LOCALHOST.", "127.1", "127.0.1", "2130706433", "0177.0.0.1", "0x7f000001",
      "[::1]", "[0:0:0:0:0:0:0:1]", "[::ffff:127.0.0.1]", "[::ffff:127.8.9.10]", "[::ffff:7f00:1]",
      "0.0.0.0", "0.0", "0", "0x0", "[::]", "[0:0:0:0:0:0:0:0]", "[::ffff:0.0.0.0]", "[::ffff:0:0]"]) {
      expect(() => assertPrivateReleaseConfig({...env, MENTRA_PUBLIC_OPENALMA_BASE_URL: `http://${host}:8099`}))
        .toThrow("phone-reachable")
    }
    expect(() => assertPrivateReleaseConfig({...env, MENTRA_PUBLIC_OPENALMA_USER_ID: ""})).toThrow(
      "MENTRA_PUBLIC_OPENALMA_USER_ID",
    )
    expect(() => assertPrivateReleaseConfig({...env, MENTRA_RELEASE_HOST_PACKAGE: "unknown"})).toThrow(
      "Unknown Mentra app installation",
    )
    for (const baseUrl of ["invalid", "ftp://iris.example", "http://user@iris.example", "http://user:pass@iris.example",
      "http://iris.example?q=1", "http://iris.example#fragment", "http://iris.example/prefix",
      "https://iris.example/prefix/", "http://iris.example//", "http://iris.example:65536", "http://iris.example:bad"]) {
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

  test("run clears its child and status on malformed output or fatal stdout failure", async () => {
    for (const fatalOutput of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), "iris-release-run-test-"))
      const statusPath = join(root, "build", "release-private-status.json")
      let wrapper
      try {
        mkdirSync(join(root, "scripts"))
        mkdirSync(join(root, "node_modules", "@mentra", "miniapp-cli", "src"), {recursive: true})
        for (const name of ["release-private.mjs", "load-env-local.mjs"]) {
          copyFileSync(fileURLToPath(new URL(name, import.meta.url)), join(root, "scripts", name))
        }
        symlinkSync(fileURLToPath(new URL("../node_modules/qrcode", import.meta.url)), join(root, "node_modules", "qrcode"))
        writeReleaseStatus(statusPath, {device_session_id: "test-phone"})
        const uri = fatalOutput
          ? "miniapp://release?url=http://[&package=com.openalma.mentra&version=0.1.0"
          : "miniapp://release?url=invalid"
        writeFileSync(join(root, "node_modules", "@mentra", "miniapp-cli", "src", "index.ts"), `
import {writeFileSync} from "node:fs"
writeFileSync("child.pid", String(process.pid))
writeFileSync("child.executable", process.execPath)
process.on("SIGTERM", () => {
  writeFileSync("child.stopped", "SIGTERM")
  process.exit(0)
})
setInterval(() => {}, 1000)
console.log(${JSON.stringify(uri)})
`)
        wrapper = spawn(process.execPath, [join(root, "scripts", "release-private.mjs")], {
          cwd: root,
          env: {
            ...process.env,
            MENTRA_PUBLIC_OPENALMA_BASE_URL: "http://192.0.2.1",
            MENTRA_PUBLIC_OPENALMA_USER_ID: "Test User",
            MENTRA_PUBLIC_OPENALMA_DEVICE_SESSION_ID: "test-phone",
            MENTRA_RELEASE_HOST_PACKAGE: "com.mentra.mentra.openalma",
          },
          stdio: ["ignore", "pipe", "pipe"],
        })
        let stderr = ""
        wrapper.stderr.on("data", (chunk) => { stderr += chunk })
        if (fatalOutput) wrapper.stdout.destroy()
        else wrapper.stdout.resume()
        const [code, signal] = await once(wrapper, "close", {signal: AbortSignal.timeout(2000)})
        expect(code).toBe(fatalOutput ? 1 : 0)
        expect(signal).toBeNull()
        expect(stderr).toContain(fatalOutput ? "EPIPE" : "missing package identity")
        expect(existsSync(statusPath)).toBe(false)
        expect(readFileSync(join(root, "child.stopped"), "utf8")).toBe("SIGTERM")
        expect(readFileSync(join(root, "child.executable"), "utf8")).toBe(process.execPath)
      } finally {
        wrapper?.kill("SIGKILL")
        if (!existsSync(join(root, "child.stopped")) && existsSync(join(root, "child.pid"))) {
          try { process.kill(Number(readFileSync(join(root, "child.pid"), "utf8")), "SIGKILL") } catch {}
        }
        rmSync(root, {recursive: true, force: true})
      }
    }
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
