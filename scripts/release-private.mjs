#!/usr/bin/env node

import {spawn} from "node:child_process"
import {dirname, join, resolve} from "node:path"
import {fileURLToPath} from "node:url"

import QRCode from "qrcode"

import {loadEnvLocal} from "./load-env-local.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

export function rewriteReleaseUri(uri, host) {
  const release = new URL(uri)
  const source = new URL(release.searchParams.get("url"))
  source.hostname = host
  release.searchParams.set("url", source.href.replace(/\/$/, ""))
  return release.href
}

export function findReleaseUri(output) {
  return output.match(/miniapp:\/\/release\?[^\s]+/)?.[0] ?? null
}

export function run() {
  loadEnvLocal(root)
  const host = process.env.MENTRA_RELEASE_HOST ?? "10.77.0.1"
  const miniapp = spawn(join(root, "node_modules", ".bin", "mentra-miniapp"), ["release"], {
    cwd: root,
    env: process.env,
    stdio: ["inherit", "pipe", "inherit"],
  })
  let output = ""
  let emitted = false

  miniapp.stdout.on("data", async (chunk) => {
    process.stdout.write(chunk)
    if (emitted) return
    output = (output + chunk).slice(-16_384)
    const original = findReleaseUri(output)
    if (!original) return
    emitted = true

    const uri = rewriteReleaseUri(original, host)
    const release = new URL(uri)
    const version = release.searchParams.get("version")
    const qrPath = join(root, "build", `openalma-${version}-wireguard-qr.png`)
    await QRCode.toFile(qrPath, uri, {width: 1024, margin: 4, errorCorrectionLevel: "M"})
    console.log(`\nPrivate WireGuard release:\n${uri}\nQR image: ${qrPath}\n`)
  })

  function shutdown() {
    miniapp.kill("SIGTERM")
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  miniapp.on("exit", (code) => process.exit(code ?? 0))
  miniapp.on("error", (error) => {
    console.error(`Could not start Mentra release server: ${error.message}`)
    process.exit(1)
  })
}

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run()
