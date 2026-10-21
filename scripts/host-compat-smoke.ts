// Offline check of one built artifact. Pass the unpacked Glassly SDK directory.
import assert from "node:assert/strict"
import {createHash} from "node:crypto"
import {mkdtemp, readFile, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {resolve} from "node:path"
import {pathToFileURL} from "node:url"
import {runInNewContext} from "node:vm"

const root = resolve(import.meta.dir, "..")
const glasslySdk = process.argv[2]
if (!glasslySdk) throw new Error("Usage: bun scripts/host-compat-smoke.ts <Glassly SDK directory>")
const background = await readFile(resolve(root, "dist/background/index.js"), "utf8")
const manifest = JSON.parse(await readFile(resolve(root, "miniapp.json"), "utf8"))
assert.equal(manifest.sdkVersion, "0.3.0")
assert.equal(manifest.minHostVersion, undefined, "A Mentra-only host version excludes Glassly")
const fingerprint = createHash("sha256").update(background).digest("hex")
const snapshots: Record<string, any> = {}

for (const host of ["mentra", "glassly"]) {
  const sdk = host === "mentra" ? resolve(root, "node_modules/@mentra/miniapp") : resolve(glasslySdk)
  const {MockTransport} = await import(pathToFileURL(resolve(sdk, "dist/transport/mock.js")).href)
  const transport = new MockTransport({silent: true, packageName: manifest.packageName})
  const sent: any[] = []
  const storage = new Map<string, string>()
  let ticketExchanges = 0
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const intervals = new Set<ReturnType<typeof setInterval>>()
  const init = host === "mentra" ? "__mentraInitCallback" : "__initCallback"
  const inbound = host === "mentra" ? "__mentraDeliverBridgeRaw" : "__deliverBridgeRaw"
  const globals: Record<string, any> = {
    console, URL, URLSearchParams, Headers, Request, Response, AbortController, AbortSignal,
    TextEncoder, TextDecoder, crypto, btoa, atob, queueMicrotask,
    setTimeout(fn: (...args: any[]) => void, ms: number, ...args: any[]) {
      const timer = setTimeout(fn, ms, ...args); timers.add(timer); return timer
    },
    setInterval(fn: (...args: any[]) => void, ms: number, ...args: any[]) {
      const timer = setInterval(fn, ms, ...args); intervals.add(timer); return timer
    },
    clearTimeout, clearInterval,
    __OPENALMA_INSTALL_DEFAULTS__: {
      baseUrl: "https://fictional.example.invalid", userId: "Fictional Tester", installationTicket: "fictional-ticket",
    },
    async fetch(url: string, options?: RequestInit) {
      assert.equal(new URL(url).origin, "https://fictional.example.invalid", "No live network permitted")
      if (url.endsWith("/installation/seen")) {
        assert.equal(options?.method, "POST")
        const body = JSON.parse(String(options?.body))
        assert.equal(body.installation_ticket, "fictional-ticket")
        assert.equal(body.user_id, "Fictional Tester")
        assert.equal(body.soul_id, null)
        assert.equal(body.package_name, manifest.packageName)
        assert.equal(body.version, manifest.version)
        assert.ok(typeof body.device_session_id === "string" && body.device_session_id.length > 0)
        assert.equal(body.host_package, undefined)
        ticketExchanges++
        return Response.json({ok: true})
      }
      if (url.endsWith("/owner")) return Response.json({user_id: "Fictional Tester"})
      if (url.endsWith("/souls")) return Response.json({souls: []})
      throw new Error(`Unexpected fictional request: ${url}`)
    },
    __hostError(error: string) {throw new Error(error)},
    __dispatch(iface: string, method: string, args: string) {
      assert.equal(iface, "__bridge"); assert.equal(method, "send")
      const [raw] = JSON.parse(args)
      const message = JSON.parse(raw)
      sent.push(message)
      const p = message.payload
      let data: unknown
      if (p.type === "miniapp_storage_get") data = {value: storage.get(p.key) ?? null}
      else if (p.type === "miniapp_storage_list") data = {keys: [...storage.keys()]}
      else if (p.type === "miniapp_storage_set") {storage.set(p.key, p.value); data = {}}
      else {transport.send(raw); return null}
      queueMicrotask(() => globals[inbound](JSON.stringify({requestId: message.requestId,
        payload: {type: "miniapp_request_result", ok: true, data}})))
      return null
    },
  }
  const ui = (data: object) => globals[inbound](JSON.stringify({payload: {
    type: "miniapp_event", streamType: "_ui", data,
  }}))
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 3000
    while (!check()) {
      assert.ok(Date.now() < deadline, `${host}: timed out waiting for built startup/RPC`)
      await Bun.sleep(5)
    }
  }
  const latest = () => sent.filter(m => m.payload.channel === "openalma:update").at(-1)?.payload.payload
  try {
    transport.onMessage((raw: string) => globals[inbound](raw))
    await transport.open()
    runInNewContext(background, globals, {filename: "iris-background.js"})
    assert.equal(typeof globals[init], "function")
    globals[init]("fictional-session")
    await until(() => sent.some(m => m.payload.type === "miniapp_connect"))
    ui({type: "UI_OPEN"})
    await until(() => latest()?.configured && latest()?.soulLoading === false)
    assert.equal(latest().lastError, null)
    assert.equal(latest().memuAvailable, true)
    assert.equal(ticketExchanges, 1)
    assert.equal(JSON.parse(storage.get("openalma.connection-profile")!).installationConfirmed, true)
    ui({type: "UI_MESSAGE", channel: "openalma:set-mode", payload: {mode: "manual"}, seq: 1, requestId: "fictional-rpc"})
    await until(() => sent.some(m => m.payload.requestId === "fictional-rpc"))
    assert.equal(sent.find(m => m.payload.requestId === "fictional-rpc").payload.payload.ok, true)
    ui({type: "UI_MESSAGE", channel: "openalma:set-capabilities", payload: {microphoneEnabled: false}, seq: 2, requestId: "fictional-storage-rpc"})
    await until(() => sent.some(m => m.payload.requestId === "fictional-storage-rpc"))
    assert.equal(storage.get("openalma.microphone-enabled"), "0")
    snapshots[host] = latest()
    const updateCount = () => sent.filter(m => m.payload.channel === "openalma:update").length
    const beforeClose = updateCount()
    ui({type: "UI_CLOSE"})
    ui({type: "UI_MESSAGE", channel: "openalma:set-mode", payload: {mode: "continuous"}, seq: 3, requestId: "closed-rpc"})
    await Bun.sleep(10)
    assert.equal(updateCount(), beforeClose, "Closed WebView must not receive broadcasts")
    ui({type: "UI_OPEN"})
    await until(() => updateCount() > beforeClose)
    assert.equal(latest().mode, "continuous", "Reopened WebView must receive a fresh snapshot")
    assert.equal(sent.filter(m => m.payload.type === "miniapp_connect").length, 1)
    console.log(`PASS ${host}: identical background ${fingerprint}; real SDK mock handshake, setup, storage and UI RPC`)
  } finally {
    for (const timer of timers) clearTimeout(timer)
    for (const timer of intervals) clearInterval(timer)
    transport.close()
  }
}

// Both WebViews load the identical UI files; only the host-owned injected objects differ.
const server = Bun.serve({port: 0, hostname: "127.0.0.1", async fetch(request) {
  const url = new URL(request.url)
  const host = url.pathname.split("/")[1]
  if (!(host in snapshots)) return new Response("Not found", {status: 404})
  const relative = url.pathname.split("/").slice(2).join("/") || "index.html"
  const file = resolve(root, "dist/ui", relative)
  if (!file.startsWith(resolve(root, "dist/ui") + "/")) return new Response("Not found", {status: 404})
  if (relative !== "index.html") return new Response(Bun.file(file))
  const shim = `<script>
    window.addEventListener('error', e => document.documentElement.dataset.error = e.message);
    window.${host === "mentra" ? "MentraOS" : "Glassly"} = {colorScheme:'dark',safeAreaInsets:{top:20,bottom:0,left:0,right:0}};
    window.${host} = {
      ready() {document.documentElement.dataset.ready='yes'},
      on(channel, cb) {queueMicrotask(() => cb(${JSON.stringify(snapshots[host])})); return () => {}},
      request(channel, payload) {document.documentElement.dataset.rpc=channel; return Promise.resolve({ok:true})}
    };
    setTimeout(() => {
      const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Continuous');
      if (button) button.click();
    }, 1500);
  </script>`
  return new Response((await readFile(file, "utf8")).replace("<head>", `<head>${shim}`), {
    headers: {"Content-Type": "text/html"},
  })
}})
try {
  for (const host of ["mentra", "glassly"]) {
    const profile = await mkdtemp(resolve(tmpdir(), "iris-host-browser-"))
    try {
      const child = Bun.spawn(["chromium", "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
        "--no-first-run", "--disable-background-networking", "--renderer-process-limit=1", `--user-data-dir=${profile}`,
        "--dump-dom", "--virtual-time-budget=3000", `http://127.0.0.1:${server.port}/${host}/index.html`],
      {stdout: "pipe", stderr: "ignore"})
      const deadline = setTimeout(() => child.kill(), 15_000)
      try {
        const html = await new Response(child.stdout).text()
        assert.equal(await child.exited, 0)
        assert.ok(html.includes('data-ready="yes"'), `${host}: UI never reached ready`)
        assert.ok(!html.includes("data-error="), `${host}: browser error`)
        assert.ok(html.includes('class="dark"'), `${host}: initial host theme lost`)
        assert.ok(html.includes('data-rpc="openalma:set-mode"'), `${host}: SDK useRpc did not reach host bridge`)
        console.log(`PASS ${host}: identical built UI renders in Chromium, host theme, subscription and RPC`)
      } finally {clearTimeout(deadline)}
    } finally {await rm(profile, {recursive: true, force: true})}
  }
} finally {await server.stop(true)}
console.log("Offline bridge compatibility only; not phone, provider, microphone or screen-off acceptance.")
