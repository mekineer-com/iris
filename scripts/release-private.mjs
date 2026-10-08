#!/usr/bin/env node

import {spawn} from "node:child_process"
import {mkdirSync, renameSync, unlinkSync, writeFileSync} from "node:fs"
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
  "MENTRA_PUBLIC_OPENALMA_USER_ID",
  "MENTRA_PUBLIC_OPENALMA_DEVICE_SESSION_ID",
  "MENTRA_RELEASE_HOST_PACKAGE",
]

export function assertPrivateReleaseConfig(env) {
  const missing = requiredBuildEnv.filter((name) => !env[name]?.trim())
  if (missing.length) throw new Error(`Missing required build settings: ${missing.join(", ")}`)
  const url = new URL(env.MENTRA_PUBLIC_OPENALMA_BASE_URL)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Iris base URL must be an http or https URL without credentials, query, or fragment")
  }
  const hostname = url.hostname.replace(/\.$/, "")
  if (hostname === "localhost" || hostname.endsWith(".localhost") ||
      /^(?:127\.|\[::1\]$|\[::ffff:7f[0-9a-f]{2}:)/.test(hostname)) {
    throw new Error("Iris base URL must be phone-reachable, not localhost or loopback")
  }
  if (!["com.mentra.mentra", "com.mentra.mentra.openalma"].includes(env.MENTRA_RELEASE_HOST_PACKAGE)) {
    throw new Error("Unknown Mentra app installation")
  }
  return url.hostname
}

export function releaseArgs(host, bundle = process.env.MENTRA_RELEASE_BUNDLE) {
  return ["release", "--host", host, "--port", "6789", "--no-cache", ...(bundle ? ["--bundle", bundle] : [])]
}

export function releaseProfile(env) {
  return JSON.stringify({
    baseUrl: env.MENTRA_PUBLIC_OPENALMA_BASE_URL.replace(/\/+$/, ""),
    userId: decodeURIComponent(env.MENTRA_PUBLIC_OPENALMA_USER_ID),
    deviceSessionId: env.MENTRA_PUBLIC_OPENALMA_DEVICE_SESSION_ID,
  })
}

export function writeReleaseStatus(path, value) {
  mkdirSync(dirname(path), {recursive: true})
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

export function installationCompletesOffer(status, offer) {
  return status?.installed_device === offer.deviceSessionId &&
    status?.installed_package === offer.packageName &&
    status?.installed_version === offer.version &&
    Number(status?.installed_seen_at) > offer.startedAt &&
    !status?.host
}

export function run() {
  loadEnvLocal(root)
  const host = assertPrivateReleaseConfig(process.env)
  const miniapp = spawn(join(root, "node_modules", ".bin", "mentra-miniapp"), releaseArgs(host), {
    cwd: root,
    env: {...process.env, MENTRA_RELEASE_DEFAULTS: releaseProfile(process.env)},
    stdio: ["inherit", "pipe", "inherit"],
  })
  let output = ""
  let emitted = false
  let shutdownRequested = false
  let pollTimer = null
  let polling = false
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
    const deviceSessionId = process.env.MENTRA_PUBLIC_OPENALMA_DEVICE_SESSION_ID
    const qrPath = join(root, "build", `openalma-${version}-private-qr.png`)
    try {
      writeReleaseStatus(statusPath, {
        release_uri: uri,
        package_name: packageName,
        version,
        device_session_id: deviceSessionId,
        host_package: process.env.MENTRA_RELEASE_HOST_PACKAGE,
        pid: process.pid,
        started_at: startedAt,
      })
    } catch (error) {
      console.error(`Could not write private release status: ${error.message}`)
      shutdown()
      return
    }
    const poll = async () => {
      if (polling || shutdownRequested) return
      polling = true
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 2000)
      try {
        const query = new URLSearchParams({device_session_id: deviceSessionId})
        const response = await fetch(
          `${process.env.MENTRA_PUBLIC_OPENALMA_BASE_URL.replace(/\/+$/, "")}/integration/mentra/status?${query}`,
          {signal: controller.signal},
        )
        if (!response.ok) return
        const status = await response.json()
        if (installationCompletesOffer(status, {
          deviceSessionId, packageName, version, startedAt,
        })) {
          console.log(`Iris ${version} reported installed on ${deviceSessionId}; stopping installer`)
          shutdown()
        }
      } catch {
        // Transient status failures must not interrupt a manual installation.
      } finally {
        clearTimeout(timeout)
        polling = false
      }
    }
    if (process.env.MENTRA_RELEASE_HOST_PACKAGE === "com.mentra.mentra") {
      pollTimer = setInterval(() => void poll(), 2000)
      void poll()
    }
    void QRCode.toFile(qrPath, uri, {width: 1024, margin: 4, errorCorrectionLevel: "M"})
      .then(() => console.log(`\nPrivate network release:\n${uri}\nQR image: ${qrPath}\n`))
      .catch((error) => console.error(`Could not write private release QR: ${error.message}`))
  })

  function shutdown() {
    if (shutdownRequested) return
    shutdownRequested = true
    cleanup()
    miniapp.kill("SIGTERM")
  }

  function cleanup() {
    if (pollTimer) clearInterval(pollTimer)
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
