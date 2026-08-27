#!/usr/bin/env node

import {spawn} from "node:child_process"
import {dirname, join} from "node:path"
import {fileURLToPath} from "node:url"

import {loadEnvLocal} from "./load-env-local.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
loadEnvLocal(root)

const miniapp = spawn("bun", ["x", "mentra-miniapp", "dev"], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
})

function shutdown(signal) {
  if (miniapp && !miniapp.killed) miniapp.kill(signal)
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

miniapp.on("exit", (code) => {
  process.exit(code ?? 0)
})

miniapp.on("error", (error) => {
  console.error(`Could not start Mentra dev server: ${error.message}`)
  process.exit(1)
})
