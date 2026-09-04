/**
 * Two-output bundle: background IIFE for the host JSContext, UI for the WebView.
 * @mentra/miniapp/background is bundled in — the JSContext has no module resolver.
 */

import {existsSync} from "fs"
import {rm} from "fs/promises"
import {reactSingletonPlugin} from "@mentra/miniapp-cli/build-helpers"

try {
  const envPath = `${import.meta.dir}/.env.local`
  if (existsSync(envPath)) {
    const text = await Bun.file(envPath).text()
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      let value = trimmed.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (process.env[key] === undefined) {
        process.env[key] = value
      }
    }
  }
} catch {
  /* ignore missing/unreadable .env.local */
}

const distDir = "./dist"
await rm(distDir, {recursive: true, force: true})

const define: Record<string, string> = {}
define["process.env.NODE_ENV"] = JSON.stringify(process.env.NODE_ENV ?? "development")
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("MENTRA_PUBLIC_") && typeof v === "string") {
    define[`process.env.${k}`] = JSON.stringify(v)
  }
}
for (const key of [
  "MENTRA_PUBLIC_OPENALMA_BASE_URL",
  "MENTRA_PUBLIC_OPENALMA_BEARER",
  "MENTRA_PUBLIC_OPENALMA_USER_ID",
  "MENTRA_PUBLIC_OPENALMA_SOUL_ID",
  "MENTRA_PUBLIC_OPENALMA_DEVICE_SESSION_ID",
]) {
  define[`process.env.${key}`] ??= JSON.stringify("")
}

const backgroundResult = await Bun.build({
  entrypoints: ["./src/background/index.ts"],
  outdir: `${distDir}/background`,
  target: "browser",
  format: "iife",
  minify: false,
  define,
})
if (!backgroundResult.success) {
  console.error("Background build failed:")
  for (const log of backgroundResult.logs) console.error(log)
  process.exit(1)
}

const uiResult = await Bun.build({
  entrypoints: ["./src/ui/index.html"],
  outdir: `${distDir}/ui`,
  target: "browser",
  plugins: [reactSingletonPlugin(import.meta.url)],
  minify: true,
  define,
})
if (!uiResult.success) {
  console.error("UI build failed:")
  for (const log of uiResult.logs) console.error(log)
  process.exit(1)
}
