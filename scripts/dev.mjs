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

function shutdown() {
  miniapp.kill("SIGTERM")
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

miniapp.on("exit", (code) => {
  process.exit(code ?? 0)
})

miniapp.on("error", (error) => {
  console.error(`Could not start Mentra dev server: ${error.message}`)
  process.exit(1)
})
