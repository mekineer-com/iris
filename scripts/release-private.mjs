#!/usr/bin/env bun

import {spawn} from "node:child_process"
import {mkdirSync, renameSync, unlinkSync, writeFileSync} from "node:fs"
import {BlockList, isIP} from "node:net"
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
  "MENTRA_RELEASE_HOST_PACKAGE",
]

const localAddresses = new BlockList()
// IPv4 rules also match IPv4-mapped IPv6 addresses.
localAddresses.addSubnet("127.0.0.0", 8, "ipv4")
localAddresses.addAddress("0.0.0.0", "ipv4")
localAddresses.addAddress("::1", "ipv6")
localAddresses.addAddress("::", "ipv6")

export function assertPrivateReleaseConfig(env) {
  const identity = env.MENTRA_RELEASE_HOST_PACKAGE === "com.mentra.mentra"
    ? "MENTRA_PUBLIC_OPENALMA_INSTALLATION_TICKET" : "MENTRA_PUBLIC_OPENALMA_DEVICE_SESSION_ID"
  const missing = [...requiredBuildEnv, identity].filter((name) => !env[name]?.trim())
  if (missing.length) throw new Error(`Missing required build settings: ${missing.join(", ")}`)
  const url = new URL(env.MENTRA_PUBLIC_OPENALMA_BASE_URL)
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("Iris base URL must be an http or https origin without a path, credentials, query, or fragment")
  }
  const hostname = url.hostname.replace(/^\[|\]$|\.$/g, "")
  if (hostname === "localhost" || hostname.endsWith(".localhost") ||
      localAddresses.check(hostname, isIP(hostname) === 6 ? "ipv6" : "ipv4")) {
    throw new Error("Iris base URL must be phone-reachable, not localhost, loopback, or unspecified")
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
    ...(env.MENTRA_RELEASE_HOST_PACKAGE === "com.mentra.mentra"
      ? {installationTicket: env.MENTRA_PUBLIC_OPENALMA_INSTALLATION_TICKET}
      : {deviceSessionId: env.MENTRA_PUBLIC_OPENALMA_DEVICE_SESSION_ID}),
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
  return !!offer.installationTicket && (status?.installations ?? []).some((record) =>
    record.installation_ticket === offer.installationTicket &&
    record.package_name === offer.packageName &&
    record.version === offer.version &&
    Number(record.seen_at) > offer.startedAt &&
    !record.host)
}

export function run() {
  loadEnvLocal(root)
  const host = assertPrivateReleaseConfig(process.env)
  const miniapp = spawn(process.execPath, [join(root, "node_modules", "@mentra", "miniapp-cli", "src", "index.ts"), ...releaseArgs(host)], {
    cwd: root,
    env: {...process.env, MENTRA_RELEASE_DEFAULTS: releaseProfile(process.env)},
    stdio: [process.platform === "win32" ? "pipe" : "inherit", "pipe", "inherit"],
  })
  let output = ""
  let emitted = false
  let shutdownRequested = false
  let pollTimer = null
  let polling = false
  let failureCode = 0
  const startedAt = Date.now() / 1000

  miniapp.stdout.on("data", (chunk) => {
    try {
      onOutput(chunk)
    } catch (error) {
      fail(error)
    }
  })

  function onOutput(chunk) {
    if (!process.stdout.destroyed) process.stdout.write(chunk)
    if (shutdownRequested || emitted) return
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
    const deviceSessionId = process.env.MENTRA_PUBLIC_OPENALMA_DEVICE_SESSION_ID || ""
    const installationTicket = process.env.MENTRA_PUBLIC_OPENALMA_INSTALLATION_TICKET || ""
    const qrPath = join(root, "build", `openalma-${version}-private-qr.png`)
    try {
      writeReleaseStatus(statusPath, {
        release_uri: uri,
        package_name: packageName,
        version,
        device_session_id: deviceSessionId,
        installation_ticket: installationTicket,
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
        const response = await fetch(
          `${process.env.MENTRA_PUBLIC_OPENALMA_BASE_URL.replace(/\/+$/, "")}/integration/mentra/status`,
          {signal: controller.signal},
        )
        if (!response.ok) return
        const status = await response.json()
        if (installationCompletesOffer(status, {
          installationTicket, packageName, version, startedAt,
        })) {
          console.log(`Iris ${version} reported installed for this ticket; stopping installer`)
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
  }

  function fail(error) {
    failureCode = 1
    console.error(`Mentra release failed: ${error.message}`)
    shutdown()
  }

  function shutdown() {
    if (shutdownRequested) return
    shutdownRequested = true
    if (pollTimer) clearInterval(pollTimer)
    if (process.platform === "win32") miniapp.stdin.end("stop\n")
    else miniapp.kill("SIGTERM")
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
  process.stdout.on("error", fail)
  miniapp.stdin?.on("error", fail)
  miniapp.on("close", (code, signal) => {
    cleanup()
    process.exit(failureCode || (code ?? (signal ? 1 : 0)))
  })
  miniapp.on("error", (error) => {
    console.error(`Could not start Mentra release server: ${error.message}`)
    failureCode = 1
  })
}

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run()
