import {describe, expect, test} from "bun:test"
import {spawn, spawnSync} from "node:child_process"
import {once} from "node:events"
import {createConnection} from "node:net"
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

async function waitForFile(path) {
  const deadline = Date.now() + 3000
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`)
    await Bun.sleep(10)
  }
}

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

  for (const windows of [false, true]) {
    for (const mode of ["malformed", "epipe", "signal", "completion", "natural", "spawn-error", "pipe-error"]) {
      if (!windows && mode === "pipe-error") continue
      test(`wrapper waits for cleanup: ${windows ? "Windows stdin" : "POSIX SIGTERM"}, ${mode}`, async () => {
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
          const uri = mode === "malformed" ? "miniapp://release?url=invalid"
            : "miniapp://release?url=http://192.0.2.1&package=com.openalma.mentra&version=0.1.0"
          writeFileSync(join(root, "node_modules", "@mentra", "miniapp-cli", "src", "index.ts"), `
import {writeFileSync} from "node:fs"
import {spawn} from "node:child_process"
writeFileSync("child.pid", String(process.pid))
writeFileSync("child.executable", process.execPath)
let stopping = false
function stop(transport) {
  if (stopping) return
  stopping = true
  writeFileSync("child.transport", transport)
  // Keep stdout open after this process exits, exercising wrapper 'close', not 'exit'.
  const finish = ${JSON.stringify(`
    const fs = require("node:fs");
    setTimeout(() => {
      fs.writeFileSync("child.status-during-cleanup", String(fs.existsSync("build/release-private-status.json")));
      fs.writeFileSync("child.stopped", "done");
    }, 150);
  `)}
  spawn(process.execPath, ["-e", finish], {stdio: ["ignore", "inherit", "inherit"]})
  process.exit(0)
}
process.on("SIGTERM", () => stop("SIGTERM"))
process.stdin.on("data", (data) => { if (data.toString().includes("stop\\n")) stop("stdin") })
setInterval(() => {}, 1000)
${mode === "pipe-error" ? 'setTimeout(() => stop("natural"), 300)' : ""}
writeFileSync("child.ready", "ready")
${mode === "natural" ? 'stop("natural")' : `console.log(${JSON.stringify(uri)})`}
`)
          const script = join(root, "scripts", "release-private.mjs")
          writeFileSync(join(root, "runner.mjs"), `
${windows ? 'Object.defineProperty(process, "platform", {value: "win32"})' : ""}
${mode === "spawn-error" ? 'Object.defineProperty(process, "execPath", {value: "/nonexistent-iris-fixture-bun"})' : ""}
${mode === "completion" ? `globalThis.fetch = async () => Response.json({installations: [{installation_ticket: "test-ticket", package_name: "com.openalma.mentra", version: "0.1.0", seen_at: Date.now() / 1000 + 1}]})` : ""}
${mode === "pipe-error" ? `
// Bun's Linux pipe sink can swallow a peer close; inject its Windows error event.
const {mock} = await import("bun:test")
const {spawn} = await import("node:child_process")
mock.module("node:child_process", () => ({spawn(...args) {
  const child = spawn(...args)
  child.stdin.end = () => { child.stdin.emit("error", new Error("fixture EPIPE")); return child.stdin }
  return child
}}))
` : ""}
process.argv[1] = ${JSON.stringify(script)}
await import(${JSON.stringify(script)})
`)
          wrapper = spawn(process.execPath, [join(root, "runner.mjs")], {
            cwd: root,
            env: {
              ...process.env,
              MENTRA_PUBLIC_OPENALMA_BASE_URL: "http://192.0.2.1",
              MENTRA_PUBLIC_OPENALMA_USER_ID: "Test User",
              MENTRA_PUBLIC_OPENALMA_DEVICE_SESSION_ID: "test-phone",
              MENTRA_PUBLIC_OPENALMA_INSTALLATION_TICKET: "test-ticket",
              MENTRA_RELEASE_HOST_PACKAGE: mode === "completion" ? "com.mentra.mentra" : "com.mentra.mentra.openalma",
            },
            stdio: ["ignore", "pipe", "pipe"],
          })
          const closed = once(wrapper, "close", {signal: AbortSignal.timeout(4000)})
          let stderr = ""
          wrapper.stderr.on("data", (chunk) => { stderr += chunk })
          if (mode === "epipe") wrapper.stdout.destroy()
          else wrapper.stdout.resume()
          if (mode === "signal" || mode === "pipe-error") {
            await waitForFile(join(root, "child.ready"))
            wrapper.kill("SIGINT")
            if (mode === "signal") wrapper.kill("SIGINT")
          }
          const [code, signal] = await closed
          expect(code).toBe(["epipe", "spawn-error", "pipe-error"].includes(mode) ? 1 : 0)
          expect(signal).toBeNull()
          expect(existsSync(statusPath)).toBe(false)
          if (mode === "spawn-error") {
            expect(stderr).toContain("Could not start")
          } else {
            if (mode === "epipe" || mode === "pipe-error") expect(stderr).toContain("EPIPE")
            if (mode === "malformed") expect(stderr).toContain("missing package identity")
            expect(readFileSync(join(root, "child.status-during-cleanup"), "utf8")).toBe("true")
            expect(readFileSync(join(root, "child.stopped"), "utf8")).toBe("done")
            expect(readFileSync(join(root, "child.transport"), "utf8")).toBe(
              ["natural", "pipe-error"].includes(mode) ? "natural" : windows ? "stdin" : "SIGTERM",
            )
            expect(readFileSync(join(root, "child.executable"), "utf8")).toBe(process.execPath)
          }
        } finally {
          wrapper?.kill("SIGKILL")
          if (!existsSync(join(root, "child.stopped")) && existsSync(join(root, "child.pid"))) {
            try { process.kill(Number(readFileSync(join(root, "child.pid"), "utf8")), "SIGKILL") } catch {}
          }
          rmSync(root, {recursive: true, force: true})
        }
      })
    }
  }

  for (const mode of ["stdin", "SIGINT", "SIGTERM", "acknowledgement", "early-stdin"]) {
    test(`patched CLI drains active downloads: ${mode}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "iris-release-drain-"))
      let child
      let download
      try {
        const manifest = JSON.parse(readFileSync(new URL("../miniapp.json", import.meta.url), "utf8"))
        const zip = new JSZip()
        zip.file("miniapp.json", JSON.stringify(manifest))
        zip.file("payload.bin", Buffer.alloc(16 * 1024 * 1024, 42))
        const bundle = await zip.generateAsync({type: "nodebuffer", compression: "STORE"})
        const bundlePath = join(root, "bundle.zip")
        writeFileSync(bundlePath, bundle)
        const socket = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response()})
        const port = socket.port
        await socket.stop()
        const cli = fileURLToPath(new URL("../node_modules/@mentra/miniapp-cli/src/index.ts", import.meta.url))
        writeFileSync(join(root, "runner.mjs"), `
import {writeFileSync} from "node:fs"
${mode.includes("stdin") ? 'Object.defineProperty(process, "platform", {value: "win32"})' : ""}
const serve = Bun.serve
Bun.serve = (options) => {
  const server = serve(options)
  const stop = server.stop.bind(server)
  server.stop = (force) => {
    writeFileSync("draining", String(force))
    return stop(force)
  }
  return server
}
process.argv = [process.execPath, ${JSON.stringify(cli)}, "release", "--host", "127.0.0.1", "--port", "${port}", "--bundle", ${JSON.stringify(bundlePath)}]
await import(${JSON.stringify(cli)})
writeFileSync("returned", "done")
`)
        child = spawn(process.execPath, [join(root, "runner.mjs")], {
          cwd: root, stdio: ["pipe", "pipe", "pipe"],
          env: {...process.env, MENTRA_RELEASE_DEFAULTS: "", MENTRA_RELEASE_HOST_PACKAGE: "com.mentra.mentra.openalma"},
        })
        const closed = once(child, "close", {signal: AbortSignal.timeout(4000)})
        let output = ""
        let stderr = ""
        child.stderr.on("data", (chunk) => { stderr += chunk })
        child.stdout.on("data", (chunk) => { output += chunk })
        if (mode === "early-stdin") {
          child.stdin.end("stop\n")
        } else {
          while (!output.includes("Serving on")) {
            if (child.exitCode !== null) throw new Error(`CLI exited: ${output}\n${stderr}`)
            await Bun.sleep(10)
          }
          const target = new URL(findReleaseUri(output)).searchParams.get("url")
          download = createConnection({host: "127.0.0.1", port})
          await once(download, "connect", {signal: AbortSignal.timeout(3000)})
          download.pause()
          const chunks = []
          download.on("data", (chunk) => { chunks.push(Buffer.from(chunk)) })
          const ended = once(download, "end", {signal: AbortSignal.timeout(3000)})
          download.write(`GET ${new URL(target).pathname}/bundle.zip HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)
          while (!output.includes("Install #1")) {
            if (child.exitCode !== null) throw new Error(`CLI exited: ${output}\n${stderr}`)
            await Bun.sleep(10)
          }
          if (mode === "stdin") {
            child.stdin.write("st")
            child.stdin.end("op\nstop\n")
          } else if (mode === "acknowledgement") {
            const offerId = new URL(target).pathname.slice(1)
            const response = await fetch(`http://127.0.0.1:${port}/__mentra_release/installed`, {
              method: "POST", body: JSON.stringify({offerId}),
            })
            expect(response.status).toBe(200)
          } else child.kill(mode)
          await waitForFile(join(root, "draining"))
          expect(readFileSync(join(root, "draining"), "utf8")).toBe("false")
          expect(child.exitCode).toBeNull()
          expect(existsSync(join(root, "returned"))).toBe(false)
          if (mode === "stdin") child.kill("SIGINT")
          download.resume()
          await ended
          const response = Buffer.concat(chunks)
          expect(response.subarray(0, 12).toString()).toBe("HTTP/1.1 200")
          expect(response.subarray(response.indexOf("\r\n\r\n") + 4).equals(bundle)).toBe(true)
        }
        const [code, signal] = await closed
        expect(stderr).toBe("")
        expect(code).toBe(0)
        expect(signal).toBeNull()
        expect(readFileSync(join(root, "returned"), "utf8")).toBe("done")
        if (mode === "early-stdin") {
          expect(output).not.toContain("Serving on")
          expect(existsSync(join(root, "draining"))).toBe(false)
        }
      } finally {
        download?.destroy()
        child?.kill("SIGKILL")
        rmSync(root, {recursive: true, force: true})
      }
    })
  }

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
