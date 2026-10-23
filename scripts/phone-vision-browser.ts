import assert from "node:assert/strict"
import {mkdtempSync, rmSync} from "node:fs"
import {readFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {fileURLToPath} from "node:url"
import {GeminiLiveController} from "../src/background/GeminiLiveController"
import {VISION_SETTINGS} from "../src/shared/types"

async function check() {
  const chromium = Bun.which(process.env.CHROMIUM ?? "chromium")
  if (!chromium) throw new Error("Chromium is required for test:browser; set CHROMIUM to its executable path")
  const built = await Bun.build({entrypoints: [fileURLToPath(new URL("./phone-vision.fixture.ts", import.meta.url))],
    target: "browser", define: {"process.env.NODE_ENV": '"development"'}})
  if (!built.success) throw new Error(built.logs.join("\n"))
  const js = await built.outputs[0].text()
  const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch(req) {
    return new URL(req.url).pathname === "/fixture.js" ? new Response(js, {headers: {"content-type": "application/javascript"}})
      : new Response('<!doctype html><script type="module" src="/fixture.js"></script>', {headers: {"content-type": "text/html"}})
  }})
  const folder = mkdtempSync(join(tmpdir(), "iris-ui-vision-"))
  const proc = Bun.spawn([chromium, "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking",
    "--renderer-process-limit=1", "--autoplay-policy=no-user-gesture-required", "--remote-debugging-port=0",
    `--user-data-dir=${folder}`, "about:blank"], {stdout: "ignore", stderr: "ignore"})
  const sockets: WebSocket[] = []
  async function cdp(url: string) {
    const socket = new WebSocket(url); sockets.push(socket)
    await new Promise<void>((resolve, reject) => {socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("CDP unavailable"))})
    let sequence = 0
    const pending = new Map<number, {resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>()
    socket.onmessage = event => {
      const response = JSON.parse(String(event.data)), waiter = pending.get(response.id)
      if (!waiter) return
      clearTimeout(waiter.timer); pending.delete(response.id)
      response.error ? waiter.reject(new Error(JSON.stringify(response.error))) : waiter.resolve(response.result)
    }
    return (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
      const id = ++sequence
      pending.set(id, {resolve, reject, timer: setTimeout(() => {pending.delete(id); reject(new Error(`${method} did not finish`))}, 45_000)})
      socket.send(JSON.stringify({id, method, params}))
    })
  }
  let browser: Awaited<ReturnType<typeof cdp>> | undefined
  try {
    let port = ""
    for (let n = 0; n < 100; n++) {
      try {port = (await readFile(join(folder, "DevToolsActivePort"), "utf8")).split("\n")[0]; break} catch {}
      await Bun.sleep(50)
    }
    if (!port) throw new Error("Chromium did not start")
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as any
    browser = await cdp(version.webSocketDebuggerUrl)
    const {targetId} = await browser("Target.createTarget", {url: `http://127.0.0.1:${server.port}/`})
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as any[]
    const page = await cdp(targets.find(target => target.id === targetId).webSocketDebuggerUrl)
    let response: any
    for (let n = 0; n < 100; n++) {
      response = await page("Runtime.evaluate", {expression: "window.visionTest || null", awaitPromise: true, returnByValue: true})
      if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails))
      if (response.result?.value) break
      await Bun.sleep(50)
    }
    const result = response.result.value
    if (!result?.ok) throw new Error(JSON.stringify(result))
    assert.equal(result.checks.length, 10)
    // Validate actual browser JPEG/wire payloads at the production admission boundary.
    const noop = () => {}
    const controller = new GeminiLiveController({baseUrl: "http://127.0.0.1:1", userId: "FictionalOwner",
      soulId: "Quill", deviceSessionId: "fixture-phone", packageName: "fixture.iris", version: "test"},
    {onAudio: noop, onTurnComplete: noop, onInterrupted: noop, onReconnecting: noop, onUsage: noop,
      onDurationWarning: noop, onPhotoRetryChange: noop, onPersistenceError: noop, onError: noop}, {frameRetention: VISION_SETTINGS})
    for (const frame of result.frames) assert.deepEqual(controller.admitFrame(frame), {retained: false, delivery: "not-sent", reason: "unavailable"})
    console.log(result.checks.join("\n"))
  } finally {
    if (browser) await browser("Browser.close").catch(() => {})
    for (const socket of sockets) socket.close()
    for (let n = 0; n < 50 && proc.exitCode === null; n++) await Bun.sleep(50)
    if (proc.exitCode === null) proc.kill("SIGTERM")
    await proc.exited
    server.stop(true); rmSync(folder, {recursive: true, force: true})
  }
}

await check()
