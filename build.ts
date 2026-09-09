/**
 * Two-output bundle: background IIFE for the host JSContext, UI for the WebView.
 * @mentra/miniapp/background is bundled in — the JSContext has no module resolver.
 */

import {rm} from "fs/promises"
import {reactSingletonPlugin} from "@mentra/miniapp-cli/build-helpers"

const distDir = "./dist"
await rm(distDir, {recursive: true, force: true})

const define: Record<string, string> = {}
define["process.env.NODE_ENV"] = JSON.stringify(process.env.NODE_ENV ?? "development")

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
