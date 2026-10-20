import {describe, expect, test} from "bun:test"
import {readFileSync} from "node:fs"
import {runInNewContext} from "node:vm"
import ts from "typescript"
import * as jsx from "react/jsx-runtime"
import manifest from "../../../miniapp.json"

import {
  imageRequest,
  newImageId,
  shouldWarnLargeImage,
  statusText,
  validateImageFile,
  visibleConnection,
} from "./SessionPage"

type Node = {props: Record<string, any>}
const nodes = (tree: any): any[] => !tree || typeof tree !== "object" ? []
  : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]

function renderPage(snapshot: object, rpc: (channel: string, payload: any) => Promise<unknown>) {
  const states: unknown[] = []
  const refs: Array<{current: unknown}> = []
  let cursor = 0
  let refCursor = 0
  const context = {
    exports: {}, btoa, localStorage: {getItem: () => null},
    require: (name: string) => {
      if (name === "react") return {
        useState(initial: unknown) {
          const index = cursor++
          if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial
          return [states[index], (value: unknown) => {states[index] = typeof value === "function" ? value(states[index]) : value}]
        },
        useEffect() {},
        useRef(value: unknown) {return refs[refCursor++] ??= {current: value}},
      }
      if (name === "react/jsx-runtime") return jsx
      if (name.endsWith("miniapp.json")) return {default: manifest, __esModule: true}
      if (name.endsWith("/useChannel")) return {useChannel: () => snapshot}
      if (name === "@mentra/miniapp/ui") return {useRpc: (channel: string) => (payload: unknown) => rpc(channel, payload)}
      return {default: "", __esModule: true}
    },
  }
  const source = readFileSync(new URL("./SessionPage.tsx", import.meta.url), "utf8")
  runInNewContext(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}}).outputText, context)
  return () => {cursor = refCursor = 0; return (context.exports as {default: () => Node}).default()}
}

describe("SessionPage state projection", () => {
  test("caption timeline is collapsed, keeps repeated text, and marks only accepted entries", () => {
    const snapshot = {configured: true, soulId: "Quill", souls: ["Quill"], soulConfirmed: true,
      connection: "listening", photoCaptions: [
        {imageId: "photo-a", caption: "A fictional repeated scene.", durable: false, receivedAt: 1000},
        {imageId: "photo-b", caption: "A fictional repeated scene.", durable: true, receivedAt: 2000},
        {imageId: "photo-a", caption: "A different fictional caption.", durable: false, receivedAt: 2500},
      ]}
    const render = renderPage(snapshot, async () => ({ok: true}))
    const panel = () => nodes(render()).find(node => node.type === "details" && node.props.className === "photo-captions")
    expect(panel().props.open).toBeUndefined()
    expect(nodes(panel()).filter(node => node.type === "p").map(node => node.props.children))
      .toEqual(["A fictional repeated scene.", "A fictional repeated scene.", "A different fictional caption."])
    expect(new Set(nodes(panel()).filter(node => node.type === "li").map(node => node.key)).size).toBe(3)
    expect(nodes(panel()).filter(node => node.props?.["aria-label"] === "Accepted by memU")).toHaveLength(1)
    expect(nodes(panel()).filter(node => node.type === "time").map(node => node.props.dateTime))
      .toEqual([new Date(1000).toISOString(), new Date(2000).toISOString(), new Date(2500).toISOString()])
    snapshot.photoCaptions = [{imageId: "photo-c", caption: "The next fictional scene.", durable: false, receivedAt: 3000}]
    expect(nodes(panel()).filter(node => node.props?.["aria-label"] === "Accepted by memU")).toHaveLength(0)
    expect(JSON.stringify(panel())).not.toContain("repeated scene")
  })

  test("server-owned photo Retry and Discard are enabled while idle", () => {
    const render = renderPage({configured: true, soulId: "Quill", souls: ["Quill"], soulConfirmed: true,
      connection: "idle", photoRetryPending: false, failedPhotos: ["server-photo"]}, async () => ({ok: true}))
    const actions = nodes(render()).filter(node => /^(Retry|Discard) failed photo/.test(node.props?.["aria-label"] ?? ""))
    expect(actions.map((button: any) => button.props.disabled)).toEqual([false, false])
    expect(JSON.stringify(render())).toContain("filing failed")
  })

  test("server failures do not block capture and actions target their chosen photo", async () => {
    const calls: unknown[] = []
    const render = renderPage({configured: true, soulId: "Quill", souls: ["Quill"], soulConfirmed: true,
      connection: "listening", photoRetryPending: false, failedPhotos: ["older-photo", "chosen-photo"]},
      async (channel, payload) => {calls.push({channel, payload}); return {ok: true}})
    expect(nodes(render()).filter(node => node.props?.type === "file").map(node => node.props.disabled))
      .toEqual([false, false])
    await nodes(render()).find(node => node.props?.["aria-label"] === "Retry failed photo 2").props.onClick()
    expect(calls).toEqual([{channel: "openalma:pending-image", payload: {action: "retry", imageId: "chosen-photo"}}])
    expect(nodes(render()).filter(node => node.props?.type === "file").map(node => node.props.disabled))
      .toEqual([false, false])
  })

  test("submitted manual recording names the selected Soul", () => {
    for (const soulId of ["Quill", "Paper Moon"]) {
      expect(statusText("listening", "manual", "submitted", soulId)).toBe(`Waiting for ${soulId}...`)
    }
  })

  test("creates without a human-name field, defers creation to Start, and preserves existing selection", async () => {
    const calls: Array<{channel: string; payload: unknown}> = []
    const snapshot = {configured: true, soulLoading: false, soulId: "Quill", souls: ["Quill"], soulConfirmed: true, soulLocked: false}
    const render = renderPage(snapshot, async (channel, payload) => {
      calls.push({channel, payload})
      return channel === "openalma:set-soul" ? {soulId: payload.soulId, created: payload.soulId !== "Quill"} : {ok: true}
    })
    const soulInput = (tree: Node) => nodes(tree).find(node => node.props?.onFocus && node.props?.value !== undefined)!
    const arrow = (tree: Node) => nodes(tree).find(node => node.props?.["aria-label"] === "Use soul")!
    const start = (tree: Node) => nodes(tree).find(node => node.props?.className === "sitting-button")!
    const human = (tree: Node) => nodes(tree).find(node => node.props?.required && node.props?.value !== undefined)
    expect(nodes(render()).find(node => node.props?.className === "iris-version")?.props.children).toEqual(["Iris ", manifest.version])

    soulInput(render()).props.onChange({target: {value: "Fable"}})
    await arrow(render()).props.onClick()
    expect(calls).toEqual([])
    expect(human(render())).toBeUndefined()
    expect(start(render()).props.disabled).toBe(false)
    await start(render()).props.onClick()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toEqual([
      {channel: "openalma:set-soul", payload: {soulId: "Fable", useExisting: false}},
      {channel: "openalma:start", payload: {mode: "continuous"}},
    ])
    soulInput(render()).props.onChange({target: {value: "Quill"}})
    await arrow(render()).props.onClick()
    expect(human(render())).toBeUndefined()
    expect(calls.at(-1)).toEqual({channel: "openalma:set-soul", payload: {soulId: "Quill", useExisting: true}})
  })

  test("Stop projection overrides a pending Start", () => {
    expect(visibleConnection("idle", true, true)).toBe("stopping")
    expect(visibleConnection("error", true, false)).toBe("starting")
    expect(visibleConnection("idle", false, false)).toBe("idle")
  })

  test.each(["Is memU running?", "Owner discovery failed (409)", "Owner discovery failed (503)"])(
    "keeps connection guidance and the actions on the next line (%s)", lastError => {
    const snapshot = {configured: true, soulLoading: false, soulId: "Quill", souls: [],
      connection: "idle", memuAvailable: false, lastError}
    const render = renderPage(snapshot, async () => ({ok: true}))
    const status = nodes(render()).find(node => node.props?.className === "memu-status")
    const content = nodes(status).find(node => node.type === "span")
    expect(content.props.children[0]).toBe(lastError)
    expect(content.props.children[1].type).toBe("br")
    expect(nodes(content).filter(node => node.type === "button").map(node => node.props.children))
      .toEqual(["Retry Connection", "Edit Connection"])
    expect(snapshot.lastError).toBe(lastError)
  })

  test("shows refused-ticket guidance without hiding the address-only connection editor", async () => {
    const snapshot = {configured: true, soulLoading: false, soulId: "", souls: [], soulConfirmed: false,
      soulLocked: true, connectionLocked: false, memuAvailable: false,
      connection: "idle", photoRetryPending: false,
      connectionProfile: {baseUrl: "http://test.example", userId: "Test User", deviceSessionId: "test-phone"},
      lastError: "Installation report failed (409): Setup ticket is unavailable or already used. Make a new Stock Install QR in the OpenAlma launcher, then install Iris from that QR.",
    }
    const calls: Array<{channel: string; payload: unknown}> = []
    const render = renderPage(snapshot, async (channel, payload) => {calls.push({channel, payload}); return {ok: true}})
    expect(JSON.stringify(render())).toContain(snapshot.lastError)
    expect(JSON.stringify(render())).not.toContain("memU is unavailable. Start memU")
    expect(nodes(render()).find(node => node.props?.className === "sitting-button").props.disabled).toBe(true)
    const retry = nodes(render()).find(node => node.props?.children === "Retry Connection")
    expect(retry).toBeDefined()
    expect(retry.props.disabled).toBe(false)
    retry.props.onClick()
    expect(nodes(render()).find(node => node.props?.children === "Checking...").props.disabled).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toEqual([{channel: "openalma:set-profile", payload: snapshot.connectionProfile}])
    snapshot.connectionLocked = true
    expect(nodes(render()).find(node => node.props?.children === "Retry Connection").props.disabled).toBe(true)
    snapshot.connectionLocked = false
    calls.length = 0
    nodes(render()).find(node => node.props?.children === "Edit Connection").props.onClick()
    const inputs = nodes(render()).filter(node => node.type === "input")
    expect(inputs.map(node => node.props.readOnly)).toEqual([false, true, true])
    expect(inputs.map(node => node.props.value)).toEqual(Object.values(snapshot.connectionProfile))
    inputs[0].props.onChange({target: {value: "http://repaired.example"}})
    nodes(render()).find(node => node.props?.children === "Save and connect").props.onClick()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toEqual([{channel: "openalma:set-profile", payload: {...snapshot.connectionProfile, baseUrl: "http://repaired.example"}}])
    for (const error of ["Installation report failed (503): Temporarily unavailable",
      "Installation report failed (409): OpenAlma owner has not been created",
      "Installation report failed (409): All stock_01 through stock_99 names are in use"]) {
      snapshot.lastError = error
      expect(JSON.stringify(render())).toContain(error)
      expect(JSON.stringify(render())).not.toContain("Make a new Stock Install QR")
    }
    snapshot.photoRetryPending = true
    for (const connection of ["idle", "error", "starting", "stopping", "reconnecting", "listening", "speaking"]) {
      snapshot.connection = connection
      const actions = nodes(render()).find(node => node.props?.className === "image-review").props.children
      expect(actions.map((node: any) => node.props.disabled)).toEqual(
        ["listening", "speaking"].includes(connection) ? [false, false] : [true, true],
      )
      expect(JSON.stringify(render()).includes("Start Iris to retry or discard the pending photo"))
        .toBe(connection === "idle" || connection === "error")
    }
  })

  for (const action of ["retry", "discard"] as const) {
    for (const [fails, boundary] of [[false, "Stop"], [true, "Stop"], [false, "error/Start"], [true, "error/Start"]] as const) {
      test(`late stored-photo ${action} ${fails ? "failure" : "success"} after ${boundary} leaves replacement UI alone`, async () => {
        const snapshot = {configured: true, soulLoading: false, soulId: "Quill", souls: ["Quill"],
          soulConfirmed: true, soulLocked: false, connection: "idle", photoRetryPending: false}
        const pending: Array<{resolve: () => void; reject: (error: Error) => void}> = []
        const calls: string[] = []
        const render = renderPage(snapshot, async (channel) => {
          calls.push(channel)
          if (channel === "openalma:pending-image") {
            return new Promise<void>((resolve, reject) => pending.push({resolve, reject}))
          }
          if (channel === "openalma:set-capabilities") throw new Error("Replacement setting failed")
          if (channel === "openalma:set-soul") return {soulId: "Quill", created: false}
          return {ok: true}
        })
        const actions = () => nodes(render()).find(node => node.props?.className === "image-review").props.children
        const flush = () => new Promise(resolve => setTimeout(resolve, 0))
        const pickPhoto = () => nodes(render()).find(node => node.props?.type === "file").props.onChange({currentTarget: {
          files: [new File([new Uint8Array([1, 2, 3])], "fictional.png", {type: "image/png"})], value: "",
        }})
        const settingError = () => nodes(render()).find(node => node.props?.type === "checkbox").props.onChange({target: {checked: false}})
        const finishOld = () => fails ? pending[0].reject(new Error("Old photo failed")) : pending[0].resolve()

        nodes(render()).find(node => node.props?.onFocus).props.onChange({target: {value: "Quill"}})
        nodes(render()).find(node => node.props?.["aria-label"] === "Use soul").props.onClick()
        await flush()
        snapshot.connection = "listening"
        snapshot.soulLocked = true
        pickPhoto()
        await flush()
        expect(JSON.stringify(render())).toContain("Photo sent")
        snapshot.photoRetryPending = true
        actions()[action === "retry" ? 0 : 1].props.onClick()
        expect(pending).toHaveLength(1)
        expect(actions().map((node: any) => node.props.disabled)).toEqual([true, true])
        if (boundary === "Stop") {
          nodes(render()).find(node => node.props?.className === "sitting-button").props.onClick()
          await flush()
          expect(calls).toContain("openalma:stop")
        } else {
          snapshot.connection = "error"
          const start = nodes(render()).find(node => node.props?.className === "sitting-button")
          expect(start.props.disabled).toBe(false)
          start.props.onClick()
          await flush()
          expect(calls).toContain("openalma:start")
          expect(calls).not.toContain("openalma:stop")
          snapshot.connection = "listening"
          expect(actions().map((node: any) => node.props.disabled)).toEqual([false, false])
          settingError()
          await flush()
          const restarted = JSON.stringify(render())
          finishOld()
          await flush()
          expect(JSON.stringify(render())).toBe(restarted)
        }

        snapshot.photoRetryPending = false
        pickPhoto()
        await flush()
        expect(calls).toContain("openalma:image")
        expect(JSON.stringify(render())).toContain("Photo sent")
        snapshot.photoRetryPending = true
        actions()[0].props.onClick()
        expect(pending).toHaveLength(2)
        settingError()
        await flush()
        const replacement = JSON.stringify(render())
        expect(replacement).toContain("Replacement setting failed")
        expect(actions().map((node: any) => node.props.disabled)).toEqual([true, true])

        if (boundary === "Stop") finishOld()
        await flush()
        expect(JSON.stringify(render())).toBe(replacement)
        pending[1].reject(new Error("Current photo failed"))
        await flush()
        expect(JSON.stringify(render())).toContain("Current photo failed")
        expect(actions().map((node: any) => node.props.disabled)).toEqual([false, false])
      })
    }
  }

  test("accepts non-empty JPEG and PNG files of any size", () => {
    expect(validateImageFile({size: 80_000, type: "image/jpeg"})).toBe("image/jpeg")
    expect(validateImageFile({size: 2_000_000, type: "image/png"})).toBe("image/png")
    expect(() => validateImageFile({size: 0, type: "image/png"})).toThrow("empty")
    expect(() => validateImageFile({size: 12, type: "image/webp"})).toThrow("JPEG or PNG")
  })

  test("warns once for large images without rejecting them", () => {
    expect(shouldWarnLargeImage(1024 * 1024 + 1, false)).toBe(true)
    expect(shouldWarnLargeImage(1024 * 1024 + 1, true)).toBe(false)
    expect(shouldWarnLargeImage(1024 * 1024, false)).toBe(false)
  })

  test("encodes one validated file for the image RPC", async () => {
    const payload = await imageRequest(
      new File([new Uint8Array([1, 2, 3])], "photo.png", {type: "image/png"}),
      newImageId(1234, 0.5),
      false,
    )
    expect(payload).toEqual({
      imageId: "image-ya-i",
      mimeType: "image/png",
      data: "AQID",
      speakDescription: false,
    })
  })

})
