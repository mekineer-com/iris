#!/usr/bin/env node

import {execFileSync, spawn} from "node:child_process"
import {networkInterfaces} from "node:os"
import {dirname, join, resolve} from "node:path"
import {fileURLToPath} from "node:url"

import QRCode from "qrcode"

import {loadEnvLocal} from "./load-env-local.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

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

  miniapp.stdout.on("data", (chunk) => {
    process.stdout.write(chunk)
    if (emitted) return
    output = (output + chunk).slice(-16_384)
    const original = findReleaseUri(output)
    if (!original) return
    emitted = true

    const uri = original
    const release = new URL(uri)
    const version = release.searchParams.get("version")
    const qrPath = join(root, "build", `openalma-${version}-wireguard-qr.png`)
    void QRCode.toFile(qrPath, uri, {width: 1024, margin: 4, errorCorrectionLevel: "M"})
      .then(() => console.log(`\nPrivate WireGuard release:\n${uri}\nQR image: ${qrPath}\n`))
      .catch((error) => console.error(`Could not write private release QR: ${error.message}`))
  })

  function shutdown() {
    shutdownRequested = true
    miniapp.kill("SIGTERM")
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  miniapp.on("exit", (code, signal) => {
    process.exit(code ?? (shutdownRequested ? 0 : signal ? 1 : 0))
  })
  miniapp.on("error", (error) => {
    console.error(`Could not start Mentra release server: ${error.message}`)
    process.exit(1)
  })
}

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run()
