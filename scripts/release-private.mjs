#!/usr/bin/env node

import {execFileSync, spawn} from "node:child_process"
import {renameSync, unlinkSync, writeFileSync} from "node:fs"
import {networkInterfaces} from "node:os"
import {dirname, join, resolve} from "node:path"
import {fileURLToPath} from "node:url"

import QRCode from "qrcode"

import {loadEnvLocal} from "./load-env-local.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const statusPath = join(root, "build", "release-private-status.json")

export function findReleaseUri(output) {
  return output.match(/miniapp:\/\/release\?[^\s]+/)?.[0] ?? null
}

const requiredBuildEnv = [
  "MENTRA_PUBLIC_OPENALMA_BASE_URL",
  "MENTRA_PUBLIC_OPENALMA_BEARER",
  "MENTRA_PUBLIC_OPENALMA_USER_ID",
  "MENTRA_PUBLIC_OPENALMA_SOUL_ID",
  "MENTRA_PUBLIC_OPENALMA_DEVICE_SESSION_ID",
]

export function assertPrivateReleaseConfig(host, env, interfaces, wireguardNames) {
  const onWireGuard = wireguardNames.some((name) =>
    (interfaces[name] ?? []).some((address) => address.family === "IPv4" && address.address === host),
  )
  if (!onWireGuard) throw new Error(`MENTRA_RELEASE_HOST ${host} is not a local WireGuard address`)
  const missing = requiredBuildEnv.filter((name) => !env[name]?.trim())
  if (missing.length) throw new Error(`Missing required build settings: ${missing.join(", ")}`)
}

export function releaseArgs(host) {
  return ["release", "--host", host, "--port", "6789"]
}

export function installationMatches(status, target) {
  return (
    status?.installed_package === target.packageName &&
    status?.installed_version === target.version &&
    Number(status?.installed_seen_at) > target.startedAt
  )
}

export function writeReleaseStatus(path, value) {
  const temporary = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value))
    renameSync(temporary, path)
  } finally {
    try {
      unlinkSync(temporary)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
  }
}

export function run() {
  loadEnvLocal(root)
  const host = process.env.MENTRA_RELEASE_HOST ?? "10.77.0.1"
  const links = JSON.parse(execFileSync("ip", ["-j", "link", "show", "type", "wireguard"], {encoding: "utf8"}))
  assertPrivateReleaseConfig(host, process.env, networkInterfaces(), links.map((link) => link.ifname))
  const miniapp = spawn(join(root, "node_modules", ".bin", "mentra-miniapp"), releaseArgs(host), {
    cwd: root,
    env: process.env,
    stdio: ["inherit", "pipe", "inherit"],
  })
  let output = ""
  let emitted = false
  let shutdownRequested = false
  let installationPoll = null
  const startedAt = Date.now() / 1000

  miniapp.stdout.on("data", (chunk) => {
    process.stdout.write(chunk)
    if (emitted) return
    output = (output + chunk).slice(-16_384)
    const original = findReleaseUri(output)
    if (!original) return
    emitted = true

    const uri = original
    const release = new URL(uri)
    const packageName = release.searchParams.get("package")
    const version = release.searchParams.get("version")
    if (!packageName || !version) {
      console.error("Mentra release URI is missing package identity")
      shutdown()
      return
    }
    const qrPath = join(root, "build", `openalma-${version}-wireguard-qr.png`)
    try {
      writeReleaseStatus(statusPath, {
        release_uri: uri,
        package_name: packageName,
        version,
        pid: process.pid,
        started_at: startedAt,
      })
    } catch (error) {
      console.error(`Could not write private release status: ${error.message}`)
      shutdown()
      return
    }
    const query = new URLSearchParams({
      user_id: process.env.MENTRA_PUBLIC_OPENALMA_USER_ID,
      soul_id: process.env.MENTRA_PUBLIC_OPENALMA_SOUL_ID,
      device_session_id: process.env.MENTRA_PUBLIC_OPENALMA_DEVICE_SESSION_ID,
    })
    installationPoll = setInterval(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:8099/integration/mentra/status?${query}`, {
          signal: AbortSignal.timeout(1000),
        })
        const status = response.ok ? await response.json() : null
        if (installationMatches(status, {packageName, version, startedAt})) shutdown()
      } catch {
        // The installer stays available and cancellable while mcp is unreachable.
      }
    }, 2000)
    void QRCode.toFile(qrPath, uri, {width: 1024, margin: 4, errorCorrectionLevel: "M"})
      .then(() => console.log(`\nPrivate WireGuard release:\n${uri}\nQR image: ${qrPath}\n`))
      .catch((error) => console.error(`Could not write private release QR: ${error.message}`))
  })

  function shutdown() {
    if (shutdownRequested) return
    shutdownRequested = true
    cleanup()
    miniapp.kill("SIGTERM")
  }

  function cleanup() {
    if (installationPoll) clearInterval(installationPoll)
    try {
      unlinkSync(statusPath)
    } catch (error) {
      if (error?.code !== "ENOENT") console.error(`Could not clear private release status: ${error.message}`)
    }
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  miniapp.on("exit", (code, signal) => {
    cleanup()
    process.exit(code ?? (shutdownRequested ? 0 : signal ? 1 : 0))
  })
  miniapp.on("error", (error) => {
    console.error(`Could not start Mentra release server: ${error.message}`)
    process.exit(1)
  })
}

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run()
