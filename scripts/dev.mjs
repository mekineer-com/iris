#!/usr/bin/env node

import {spawn} from "node:child_process"
import {dirname, join} from "node:path"
import {fileURLToPath} from "node:url"

import {loadEnvLocal} from "./load-env-local.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
loadEnvLocal(root)

const miniapp = spawn(join(root, "node_modules", ".bin", "mentra-miniapp"), ["dev"], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
})
let shutdownRequested = false

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
  console.error(`Could not start Mentra dev server: ${error.message}`)
  process.exit(1)
})
