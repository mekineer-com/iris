import {describe, expect, mock, test} from "bun:test"
import {readFileSync} from "node:fs"
import {runInNewContext} from "node:vm"
import ts from "typescript"
import * as jsx from "react/jsx-runtime"
import manifest from "../../../miniapp.json"
import {imageTimeMillis, readImageTime} from "../imageTime"
import {LIVE_MODELS, type LiveModel} from "../../shared/types"
import * as sharedTypes from "../../shared/types"

mock.module("../memu-icon.png", () => ({default: "memu-icon.png"}))
const {
  imageRequest,
  shouldWarnLargeImage,
  statusText,
  stopSecondsRemaining,
  validateImageFile,
  visibleConnection,
} = await import("./SessionPage")

type Node = {props: Record<string, any>}
const nodes = (tree: any): any[] => !tree || typeof tree !== "object" ? []
  : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]

function labelledCheckbox(tree: any, text: string) {
  const label = nodes(tree).find(node => node.type === "label" &&
    (Array.isArray(node.props.children) ? node.props.children : [node.props.children])
      .some((child: unknown) => typeof child === "string" && child.trim() === text))
  return nodes(label).find(node => node.type === "input" && node.props.type === "checkbox")
}

function renderPage(snapshot: object, rpc: (channel: string, payload: any) => Promise<unknown>, now?: number,
  prepare: (file: File) => Promise<File> = async file => file, gallerySupported = true, warningStorageFails = false) {
  for (const [field, value] of Object.entries({model: null, configuredModel: LIVE_MODELS[0], modelSaving: false,
    callMode: "audio", maxMemorizedPhotos: 1, catchUpRender: null})) {
    if (!(field in snapshot)) Object.assign(snapshot, {[field]: value})
  }
  if (!("startGeneration" in snapshot)) Object.assign(snapshot, {startGeneration: 1})
  if (!("pendingPhotoIds" in snapshot)) Object.assign(snapshot, {pendingPhotoIds: ["local-photo"]})
  const states: unknown[] = []
  const refs: Array<{current: unknown}> = []
  let cursor = 0
  let refCursor = 0
  const stored = new Map<string, string>()
  const context = {
    exports: {}, btoa, document: {hidden: false}, URL,
    window: {MentraOS: {capabilities: gallerySupported ? ["save_image_to_gallery"] : []}},
    localStorage: {getItem: (key: string) => {
      if (warningStorageFails && key.includes("gallery")) throw new Error("Fictional storage unavailable")
      return stored.get(key) ?? null
    }, setItem: (key: string, value: string) => {
      if (warningStorageFails) throw new Error("Fictional storage full")
      stored.set(key, value)
    }},
    ...(now === undefined ? {} : {Date: {now: () => now}}),
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
      if (name.endsWith("/usePhoneVision")) return {usePhoneVision: () => ({videoRef: {current: null},
        ready: true, error: null, stop() {}, takePhoto: async () => ({
          file: new File([new Uint8Array([255, 216, 255])], "video-photo.jpg", {type: "image/jpeg"}), receivedAt: 1000,
        })})}
      if (name.endsWith("/imageTime")) return {readImageTime, imageTimeMillis}
      if (name.endsWith("/prepareImage")) return {prepareImage: prepare}
      if (name.endsWith("/shared/types")) return sharedTypes
      if (name === "@mentra/miniapp/ui") return {useRpc: (channel: string) => (payload: unknown) => rpc(channel, payload)}
      return {default: "", __esModule: true}
    },
  }
  const source = readFileSync(new URL("./SessionPage.tsx", import.meta.url), "utf8")
  runInNewContext(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}}).outputText, context)
  return () => {cursor = refCursor = 0; return (context.exports as {default: () => Node}).default()}
}

describe("SessionPage state projection", () => {
  test("idle reserves an empty status row; connection activity fills it", () => {
    const snapshot = {configured: true, soulId: "Quill", souls: ["Quill"], connection: "idle"}
    const render = renderPage(snapshot, async () => ({ok: true}))
    const status = nodes(render()).find(node => node.props?.className === "status")
    expect(status).toBeDefined()
    expect(status.props.children.filter(Boolean)).toEqual([])
    for (const connection of ["starting", "reconnecting", "listening", "speaking", "stopping", "error"]) {
      snapshot.connection = connection
      expect(nodes(render()).some(node => node.props?.className === "status")).toBe(true)
    }
  })

  test("top gear toggles Settings without a visible text button", () => {
    const render = renderPage({configured: true, soulId: "Quill", souls: ["Quill"]}, async () => ({ok: true}))
    const gear = () => nodes(render()).find(node => node.props?.["aria-label"] === "Settings")
    const panel = () => nodes(render()).find(node => node.props?.id === "iris-settings")
    expect(gear().props["aria-expanded"]).toBe(false)
    const tree = nodes(render())
    expect(tree.indexOf(tree.find(node => node.props?.id === "iris-settings")))
      .toBeGreaterThan(tree.indexOf(tree.find(node => node.props?.className === "photo-controls")))
    expect(gear().props.children.props["aria-hidden"]).toBe("true")
    expect(panel().props.hidden).toBe(true)
    gear().props.onClick()
    expect(gear().props["aria-expanded"]).toBe(true)
    expect(panel().props.hidden).toBe(false)
    gear().props.onClick()
    expect(panel().props.hidden).toBe(true)
  })

  const modelSwitches = (tree: any) => nodes(nodes(tree).find(node => node.props?.["aria-label"] === "Model"))
    .filter(node => node.props?.role === "switch")

  test("reads the configured model without inventing a default", () => {
    const snapshot = {configured: true, soulId: "Quill", souls: ["Quill"],
      configuredModel: null as string | null}
    const render = renderPage(snapshot, async () => ({ok: true}))
    for (const model of [null, "custom-server-model", ...LIVE_MODELS]) {
      snapshot.configuredModel = model
      const tree = render()
      expect(modelSwitches(tree).map(button => button.props.checked)).toEqual([model === LIVE_MODELS[1]])
      const selector = nodes(tree).find(node => node.props?.["aria-label"] === "Model")
      expect(nodes(selector).some(node => node.type === "p")).toBe(false)
      expect(JSON.stringify(selector)).toContain(model ?? "Model unavailable")
      const controls = nodes(tree).find(node => node.props?.["aria-label"] === "Voice controls")
      expect(modelSwitches(controls)).toHaveLength(1)
      const settings = nodes(tree).find(node => node.props?.id === "iris-settings")
      expect(modelSwitches(settings)).toHaveLength(0)
    }
  })

  for (const [index, choice] of LIVE_MODELS.entries()) {
    for (const fails of [false, true]) {
      test(`${choice} save ${fails ? "failure retains" : "success updates"} the confirmed choice and locks Start`, async () => {
        const previous = index === 0 ? LIVE_MODELS[1] : null
        const snapshot = {configured: true, soulLoading: false, soulId: "Quill", souls: ["Quill"],
          soulConfirmed: true, soulLocked: false, connection: "idle", configuredModel: previous as LiveModel | null}
        let resolve!: () => void
        let reject!: (error: Error) => void
        const pending = new Promise<void>((res, rej) => {resolve = res; reject = rej})
        const calls: Array<{channel: string; payload: unknown}> = []
        const render = renderPage(snapshot, async (channel, payload) => {
          calls.push({channel, payload})
          if (channel === "openalma:set-soul") return {soulId: "Quill", created: false}
          if (channel === "openalma:set-model") return pending
          return {ok: true}
        })
        const start = () => nodes(render()).find(node => node.props?.className === "sitting-button")
        nodes(render()).find(node => node.props?.onFocus).props.onChange({target: {value: "Quill"}})
        nodes(render()).find(node => node.props?.["aria-label"] === "Use soul").props.onClick()
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(start().props.disabled).toBe(false)
        calls.length = 0
        modelSwitches(render())[0].props.onChange({target: {checked: index === 1}})
        expect(calls).toEqual([{channel: "openalma:set-model", payload: {model: choice}}])
        expect(modelSwitches(render()).map(button => button.props.disabled)).toEqual([true])
        expect(modelSwitches(render())[0].props.checked).toBe(previous === LIVE_MODELS[1])
        expect(start().props.disabled).toBe(true)
        if (fails) reject(new Error("Fictional model preference storage failure"))
        else {
          snapshot.configuredModel = choice
          resolve()
        }
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(modelSwitches(render())[0].props.checked).toBe((fails ? previous : choice) === LIVE_MODELS[1])
        expect(modelSwitches(render()).map(button => button.props.disabled)).toEqual([false])
        expect(start().props.disabled).toBe(false)
        if (fails) expect(JSON.stringify(render())).toContain("Fictional model preference storage failure")
      })
    }
  }

  test("Start does not save or override the configured model", async () => {
    const snapshot = {configured: true, soulLoading: false, soulId: "Quill", souls: ["Quill"],
      soulConfirmed: true, soulLocked: false, connection: "idle", configuredModel: "custom-server-model"}
    const calls: Array<{channel: string; payload: unknown}> = []
    const render = renderPage(snapshot, async (channel, payload) => {
      calls.push({channel, payload})
      return channel === "openalma:set-soul" ? {soulId: "Quill", created: false} : {ok: true}
    })
    nodes(render()).find(node => node.props?.onFocus).props.onChange({target: {value: "Quill"}})
    nodes(render()).find(node => node.props?.["aria-label"] === "Use soul").props.onClick()
    await new Promise(resolve => setTimeout(resolve, 0))
    calls.length = 0
    nodes(render()).find(node => node.props?.className === "sitting-button").props.onClick()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toEqual([{channel: "openalma:start", payload: {mode: "continuous", callMode: "audio"}}])
  })

  test("model selection locks for the whole sitting and background save; active label uses actual model", () => {
    const snapshot = {configured: true, soulLoading: false, soulId: "Quill", souls: ["Quill"], connection: "idle",
      model: "actual-lease-model", configuredModel: "custom-server-model", modelSaving: false}
    const render = renderPage(snapshot, async () => ({ok: true}))
    for (const connection of ["idle", "error", "starting", "reconnecting", "listening", "speaking", "stopping"]) {
      snapshot.connection = connection
      const locked = connection !== "idle" && connection !== "error"
      expect(modelSwitches(render()).map(button => button.props.disabled)).toEqual([locked])
      if (locked) expect(JSON.stringify(render())).toContain("actual-lease-model")
    }
    snapshot.connection = "idle"
    nodes(render()).find(node => node.props?.onFocus).props.onChange({target: {value: "Fable"}})
    nodes(render()).find(node => node.props?.["aria-label"] === "Use soul").props.onClick()
    const start = () => nodes(render()).find(node => node.props?.className === "sitting-button")
    expect(start().props.disabled).toBe(false)
    snapshot.modelSaving = true
    expect(modelSwitches(render()).map(button => button.props.disabled)).toEqual([true])
    expect(start().props.disabled).toBe(true)
    snapshot.connection = "listening"
    expect(start().props.disabled).toBe(false)
  })

  test("Closing thoughts replaces the idle call choices, defaults checked, and follows the remembered snapshot", () => {
    const snapshot = {configured: true, soulLoading: false, soulId: "Quill", souls: ["Quill"],
      soulConfirmed: true, connection: "idle", closingThoughts: undefined as boolean | undefined}
    const render = renderPage(snapshot, async () => ({ok: true}))
    const row = nodes(render()).find(node => node.props?.className === "sitting-controls sitting-start")
    expect(nodes(row).some(node => node.props?.className === "sitting-button")).toBe(true)
    expect(labelledCheckbox(row, "Closing thoughts")).toBeUndefined()
    expect(nodes(row).filter(node => node.props?.className === "sitting-button").map(node => node.props.children))
      .toEqual(["Audio", "Video"])
    snapshot.connection = "listening"
    expect(labelledCheckbox(render(), "Closing thoughts").props.checked).toBe(true)
    const settings = nodes(render()).find(node => node.props?.id === "iris-settings")
    expect(labelledCheckbox(settings, "Closing thoughts")).toBeUndefined()
    for (const connection of ["listening", "speaking", "starting", "stopping"]) {
      snapshot.connection = connection
      snapshot.closingThoughts = false
      const checkbox = labelledCheckbox(render(), "Closing thoughts")
      expect(checkbox.props.checked).toBe(false)
      expect(checkbox.props.disabled).toBe(["starting", "stopping"].includes(connection))
    }
  })

  for (const fails of [true, false]) {
    test(`pending Closing thoughts ${fails ? "failure" : "success"} locks only its checkbox, not Stop`, async () => {
      const snapshot = {configured: true, soulLoading: false, soulId: "Quill", souls: ["Quill"],
        soulConfirmed: true, connection: "listening", closingThoughts: true}
      let resolve!: () => void
      let reject!: (error: Error) => void
      const pending = new Promise<void>((res, rej) => {resolve = res; reject = rej})
      const calls: Array<{channel: string; payload: unknown}> = []
      const render = renderPage(snapshot, async (channel, payload) => {
        calls.push({channel, payload})
        if (channel === "openalma:set-closing-thoughts") return pending
        return {ok: true}
      })
      labelledCheckbox(render(), "Closing thoughts").props.onChange({target: {checked: false}})
      expect(calls).toEqual([{channel: "openalma:set-closing-thoughts", payload: {enabled: false}}])
      expect(labelledCheckbox(render(), "Closing thoughts").props).toMatchObject({disabled: true, checked: true})
      expect(labelledCheckbox(render(), "Microphone enabled").props.disabled).toBe(false)
      const stop = nodes(render()).find(node => node.props?.className === "sitting-button")
      expect(stop.props.disabled).toBe(false)
      stop.props.onClick()
      expect(calls.at(-1)?.channel).toBe("openalma:stop")
      if (fails) reject(new Error("Fictional preference storage failure"))
      else resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(labelledCheckbox(render(), "Closing thoughts").props).toMatchObject({disabled: false, checked: true})
      if (fails) expect(JSON.stringify(render())).toContain("Fictional preference storage failure")
      else {
        snapshot.closingThoughts = false
        expect(labelledCheckbox(render(), "Closing thoughts").props.checked).toBe(false)
      }
    })
  }

  for (const active of [true, false]) {
    test(`Closing thoughts is locked while the ${active ? "Stop" : "Start"} RPC is pending`, async () => {
      const snapshot = {configured: true, soulLoading: false, soulId: "Quill", souls: ["Quill"],
        soulConfirmed: true, soulLocked: false, connection: active ? "listening" : "idle"}
      let release!: () => void
      const pending = new Promise<void>(resolve => {release = resolve})
      const calls: string[] = []
      const render = renderPage(snapshot, async channel => {
        if (channel === "openalma:set-soul") return {soulId: "Quill", created: false}
        calls.push(channel)
        await pending
        return {ok: true}
      })
      if (!active) {
        nodes(render()).find(node => node.props?.onFocus).props.onChange({target: {value: "Quill"}})
        nodes(render()).find(node => node.props?.["aria-label"] === "Use soul").props.onClick()
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      nodes(render()).find(node => node.props?.className === "sitting-button").props.onClick()
      try {
        expect(calls).toEqual([active ? "openalma:stop" : "openalma:start"])
        expect(labelledCheckbox(render(), "Closing thoughts").props.disabled).toBe(true)
        expect(modelSwitches(render()).map(button => button.props.disabled)).toEqual([true])
      } finally {
        release()
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      if (active) expect(labelledCheckbox(render(), "Closing thoughts").props.disabled).toBe(false)
      else expect(labelledCheckbox(render(), "Closing thoughts")).toBeUndefined()
    })
  }

  test("a picker opened before restart cannot attach its photo to the replacement sitting", async () => {
    const calls: string[] = []
    const snapshot = {configured: true, startGeneration: 1, soulId: "Quill", souls: ["Quill"],
      soulConfirmed: true, connection: "listening", pendingPhotoIds: []}
    const render = renderPage(snapshot, async channel => {calls.push(channel); return {ok: true}})
    nodes(render()).find(node => node.props?.type === "file" && !node.props.capture).props.onClick()
    snapshot.startGeneration = 3
    await nodes(render()).find(node => node.props?.type === "file" && !node.props.capture).props.onChange({currentTarget: {
      files: [new File([new Uint8Array([1, 2, 3])], "fictional.png", {type: "image/png"})], value: "",
    }})
    expect(calls).toEqual([])
    expect(JSON.stringify(render())).toContain("Choose the photo again for this sitting.")
  })

  test("a camera returning after Stop still saves its original, but cannot upload into the next sitting", async () => {
    const calls: string[] = []
    const snapshot = {configured: true, startGeneration: 1, soulId: "Quill", souls: ["Quill"],
      soulConfirmed: true, connection: "listening", pendingPhotoIds: []}
    const render = renderPage(snapshot, async channel => {calls.push(channel); return {success: true, ok: true}})
    const picker = nodes(render()).find(node => node.props?.capture === "environment")
    picker.props.onClick()
    await nodes(render()).find(node => node.props?.children === "Stop").props.onClick()
    snapshot.connection = "idle"; snapshot.startGeneration = 2
    await picker.props.onChange({currentTarget: {files: [new File(["original"], "camera.jpg", {type: "image/jpeg"})], value: ""}})
    expect(calls).toEqual(["openalma:stop", "openalma:save-photo"])
    expect(JSON.stringify(render())).toContain("Choose the photo again for this sitting")
  })

  test("Choose image's actual handler never saves another gallery original", async () => {
    const calls: string[] = []
    const render = renderPage({configured: true, soulId: "Quill", souls: ["Quill"], soulConfirmed: true,
      connection: "listening", pendingPhotoIds: []}, async (channel, payload) => {
      calls.push(channel)
      return channel === "openalma:reserve-image" ? {startGeneration: payload.startGeneration, imageId: "chosen"} : {ok: true}
    })
    const picker = nodes(render()).find(node => node.props?.type === "file" && !node.props.capture)
    picker.props.onClick()
    await picker.props.onChange({currentTarget: {files: [new File(["chosen"], "chosen.jpg", {type: "image/jpeg"})], value: ""}})
    expect(calls).toEqual(["openalma:reserve-image", "openalma:image"])
  })

  test("a confirmed upload conflict reserves a new reference only for explicit Retry", async () => {
    const uploads: any[] = []
    let reservations = 0
    const snapshot = {configured: true, soulId: "Quill", souls: ["Quill"], soulConfirmed: true,
      connection: "listening", photoRetryPending: false, pendingPhotoIds: []}
    const render = renderPage(snapshot, async (channel, payload) => {
      if (channel === "openalma:reserve-image") return {startGeneration: payload.startGeneration,
        imageId: `2026-01-08T10-17-23${++reservations === 1 ? "" : "-2"}`}
      if (channel === "openalma:image") {
        uploads.push(payload)
        return uploads.length === 1 ? {ok: false, conflict: true} : {ok: true}
      }
      return {ok: true}
    })
    nodes(render()).find(node => node.props?.type === "file" && !node.props.capture).props.onClick()
    await nodes(render()).find(node => node.props?.type === "file" && !node.props.capture).props.onChange({currentTarget: {
      files: [new File([new Uint8Array([1, 2, 3])], "fictional.png", {type: "image/png"})], value: "",
    }})
    expect(reservations).toBe(2)
    expect(uploads).toHaveLength(1)
    nodes(render()).find(node => node.props?.children === "Retry").props.onClick()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(uploads.map(payload => payload.imageId)).toEqual(["2026-01-08T10-17-23", "2026-01-08T10-17-23-2"])
    expect(uploads[1].time).toEqual(uploads[0].time)
    expect(uploads[1].data).toBe(uploads[0].data)
    expect(JSON.stringify(render())).toContain("Photo sent")
  })

  test("capture saves original bytes/date once, then preview, upload and Retry use the prepared File", async () => {
    const original = new File([readFileSync(new URL("../fixtures/imageTime/capture.jpg", import.meta.url))],
      "capture.jpg", {type: "image/jpeg"})
    const prepared = new File(["smaller"], original.name, {type: "image/jpeg"})
    const calls: Array<{channel: string; payload: any}> = []
    let preparations = 0
    let uploads = 0
    const snapshot = {configured: true, soulId: "Quill", souls: ["Quill"], soulConfirmed: true,
      connection: "listening", photoRetryPending: false, pendingPhotoIds: []}
    const render = renderPage(snapshot, async (channel, payload) => {
      calls.push({channel, payload})
      if (channel === "openalma:save-photo") return {supported: true, success: true}
      if (channel === "openalma:reserve-image") return {startGeneration: 1, imageId: "captured-photo"}
      if (channel === "openalma:image" && ++uploads === 1) throw new Error("Upload failed")
      return {ok: true}
    }, undefined, async file => {expect(file).toBe(original); preparations++; return prepared})
    labelledCheckbox(render(), "Preview before send").props.onChange({target: {checked: true}})
    const picker = () => nodes(render()).find(node => node.props?.capture === "environment")
    picker().props.onClick()
    await picker().props.onChange({currentTarget: {files: [original], value: ""}})
    expect(calls.map(call => call.channel)).toEqual(["openalma:save-photo", "openalma:reserve-image"])
    expect(calls[0].payload.data).toBe(Buffer.from(await original.arrayBuffer()).toString("base64"))
    expect(calls[0].payload.creationTime).toBe(Date.parse("2026-01-08T10:17:23-05:00"))
    const preview = nodes(render()).find(node => node.props?.className === "image-preview")
    expect(await (await fetch(preview.props.src)).text()).toBe("smaller")
    await nodes(render()).find(node => node.props?.children === "Send").props.onClick()
    await new Promise(resolve => setTimeout(resolve, 0))
    await nodes(render()).find(node => node.props?.children === "Retry").props.onClick()
    await new Promise(resolve => setTimeout(resolve, 0))
    const sent = calls.filter(call => call.channel === "openalma:image")
    expect(sent).toHaveLength(2)
    expect(sent[0].payload).toEqual(sent[1].payload)
    expect(sent[0].payload.data).toBe(btoa("smaller"))
    expect(sent[0].payload.time.source).toBe("DateTimeOriginal")
    expect(preparations).toBe(1)
    expect(calls.filter(call => call.channel === "openalma:save-photo")).toHaveLength(1)
    URL.revokeObjectURL(preview.props.src)
  })

  test.each(["unsupported", "storage failure", "failed", "rejected"])("gallery %s never blocks sending or loses its notice", async outcome => {
    const unsupported = outcome === "unsupported" || outcome === "storage failure"
    const calls: string[] = []
    const render = renderPage({configured: true, soulId: "Quill", souls: ["Quill"], soulConfirmed: true,
      connection: "listening", photoRetryPending: false, pendingPhotoIds: []}, async (channel, payload) => {
      calls.push(channel)
      if (channel === "openalma:save-photo") {
        if (outcome === "rejected") throw new Error("Gallery save failed")
        return {supported: outcome !== "unsupported", success: false}
      }
      if (channel === "openalma:reserve-image") return {startGeneration: 1, imageId: "photo"}
      return {ok: true}
    }, undefined, async file => file, !unsupported, outcome === "storage failure")
    const pick = async () => {
      const picker = nodes(render()).find(node => node.props?.capture === "environment")
      picker.props.onClick()
      await picker.props.onChange({currentTarget: {value: "",
        files: [new File(["fictional"], "photo.png", {type: "image/png"})]}})
    }
    await pick()
    expect(calls.at(-1)).toBe("openalma:image")
    expect(JSON.stringify(render())).toContain("Photo sent")
    expect(JSON.stringify(render())).toContain(unsupported ? "cannot automatically save"
      : outcome === "rejected" ? "Gallery save not confirmed" : "Not saved to gallery")
    if (unsupported) {
      expect(calls).not.toContain("openalma:save-photo")
      await pick()
      expect(JSON.stringify(render())).not.toContain("cannot automatically save")
    }
  })

  test.each(["preparation", "gallery save"])("Stop during %s cannot attach work or errors to a replacement sitting", async stage => {
    let finish!: (value: any) => void
    const gate = new Promise<any>(resolve => {finish = resolve})
    const calls: string[] = []
    const file = new File(["fictional"], "photo.png", {type: "image/png"})
    const snapshot = {configured: true, soulId: "Quill", souls: ["Quill"], soulConfirmed: true,
      connection: "listening", startGeneration: 1, photoRetryPending: false, pendingPhotoIds: []}
    const render = renderPage(snapshot, async channel => {
      calls.push(channel)
      if (channel === "openalma:save-photo") return gate
      return {ok: true}
    }, undefined, async () => stage === "preparation" ? gate : file)
    const picker = nodes(render()).find(node => node.props?.type === "file" &&
      Boolean(node.props.capture) === (stage === "gallery save"))
    picker.props.onClick()
    const picking = picker.props.onChange({currentTarget: {files: [file], value: ""}})
    await new Promise(resolve => setTimeout(resolve, 0))
    await nodes(render()).find(node => node.props?.children === "Stop").props.onClick()
    snapshot.startGeneration = 3
    finish(stage === "preparation" ? file : {supported: true, success: false})
    await picking
    expect(calls).not.toContain("openalma:reserve-image")
    expect(calls).not.toContain("openalma:image")
    expect(JSON.stringify(render())).not.toContain("Not saved to gallery")
  })

  test.each(["Retake", "Stop"])("discarding a failed photo with %s clears its retry message", async action => {
    const render = renderPage({configured: true, soulId: "Quill", souls: ["Quill"], soulConfirmed: true,
      connection: "listening", photoRetryPending: false, pendingPhotoIds: []}, async (channel, payload) => {
      if (channel === "openalma:reserve-image") return {startGeneration: payload.startGeneration, imageId: "failed-photo"}
      if (channel === "openalma:image") throw new Error("Fictional photo upload failure")
      return {ok: true}
    })
    nodes(render()).find(node => node.props?.type === "file" && !node.props.capture).props.onClick()
    await nodes(render()).find(node => node.props?.type === "file" && !node.props.capture).props.onChange({currentTarget: {
      files: [new File([new Uint8Array([1, 2, 3])], "fictional.png", {type: "image/png"})], value: "",
    }})
    expect(JSON.stringify(render())).toContain("Photo ready to retry")
    await nodes(render()).find(node => node.props?.children === action).props.onClick()
    expect(nodes(render()).some(node => node.props?.children === "Retry")).toBe(false)
    expect(JSON.stringify(render())).not.toContain("Photo ready to retry")
  })

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
      for (const microphoneEnabled of [true, false]) {
        expect(statusText("listening", "manual", "submitted", soulId, microphoneEnabled)).toBe(`Waiting for ${soulId}...`)
      }
    }
  })

  test.each(["idle", "recording", "review"] as const)("Manual %s status respects a disabled microphone", phase => {
    expect(statusText("listening", "manual", phase, "Quill", false))
      .toBe(phase === "review" ? "Review recording" : "Microphone off")
    expect(statusText("speaking", "manual", phase, "Quill", false)).toBe("Speaking")
  })

  test.each(["continuous", "manual"] as const)("camera-only %s sitting does not claim microphone capture", mode => {
    const snapshot = {configured: true, soulId: "Quill", souls: ["Quill"], soulConfirmed: true,
      connection: "listening", mode, manualPhase: "idle", microphoneEnabled: false, cameraEnabled: true}
    const render = renderPage(snapshot, async () => ({ok: true}))
    const status = () => nodes(render()).find(node => node.props?.className === "status")
    expect(status().props.children).toContain("Microphone off")
    expect(nodes(render()).filter(node => node.props?.type === "file").map(node => node.props.disabled))
      .toEqual([false, false])
    snapshot.microphoneEnabled = true
    expect(status().props.children).toContain(mode === "continuous" ? "Listening" : "Ready")
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
      {channel: "openalma:start", payload: {mode: "continuous", callMode: "audio"}},
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

  test("Stop countdown rounds up partial seconds and clamps expired deadlines", () => {
    const stoppedAt = 1_000_000
    const deadline = stoppedAt + 30_000
    expect([0, 1, 999, 1000, 29_999, 30_000, 45_000].map(elapsed =>
      stopSecondsRemaining(deadline, stoppedAt + elapsed))).toEqual([30, 30, 30, 29, 1, 0, 0])
    expect(stopSecondsRemaining(stoppedAt + 300_000, stoppedAt + 45_000)).toBe(255)
  })

  test("inline Stop countdown uses the snapshot deadline and clears when Start is enabled early", async () => {
    const now = 1_000_000
    const snapshot = {configured: true, soulLoading: false, soulId: "Quill", souls: ["Quill"],
      soulConfirmed: true, soulLocked: false, connection: "idle", stopDeadlineAt: null as number | null}
    const render = renderPage(snapshot, async () => ({soulId: "Quill", created: false}), now)
    // This fixture skips effects, so establish the selected Soul through its existing UI actions.
    nodes(render()).find(node => node.props?.onFocus).props.onChange({target: {value: "Quill"}})
    await nodes(render()).find(node => node.props?.["aria-label"] === "Use soul").props.onClick()
    await new Promise(resolve => setTimeout(resolve, 0))
    snapshot.connection = "stopping"
    const countdown = () => nodes(render()).find(node => node.type === "span" && node.props["aria-live"] === "off")
    const button = () => nodes(render()).find(node => node.props?.className === "sitting-button")
    for (const [deadline, seconds] of [[now + 30_000, 30], [now + 255_000, 255], [now - 15_000, 0]]) {
      snapshot.stopDeadlineAt = deadline
      expect(countdown().props.children).toEqual([" ", seconds, "s remaining"])
      expect(button().props.disabled).toBe(true)
      expect(JSON.stringify(button())).toContain("Stopping...")
    }
    snapshot.stopDeadlineAt = null
    snapshot.connection = "idle"
    expect(countdown()).toBeUndefined()
    expect(button().props.disabled).toBe(false)
    expect(JSON.stringify(button())).toContain("Audio")
  })

  test.each(["Is memU running?", "Owner discovery failed (409)", "Owner discovery failed (503)"])(
    "keeps connection guidance and the actions on the next line (%s)", lastError => {
    const snapshot = {configured: true, soulLoading: false, soulId: "Quill", souls: [],
      connection: "idle", memuAvailable: false, lastError}
    const render = renderPage(snapshot, async () => ({ok: true}))
    const status = nodes(render()).find(node => node.props?.className === "memu-status")
    const guidance = nodes(status).find(node => node.props?.className === "memu-guidance")
    const actions = nodes(status).find(node => node.props?.className === "memu-actions")
    expect(guidance.props.children).toBe(lastError)
    expect(nodes(actions).filter(node => node.type === "button").map(node => node.props.children))
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
      const actions = nodes(render()).find(node => node.props?.className === "image-review").props.children.filter((node: any) => node.type === "button")
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
        const render = renderPage(snapshot, async (channel, payload) => {
          calls.push(channel)
          if (channel === "openalma:reserve-image") return {startGeneration: payload.startGeneration, imageId: payload.time.timestamp}
          if (channel === "openalma:pending-image") {
            return new Promise<void>((resolve, reject) => pending.push({resolve, reject}))
          }
          if (channel === "openalma:set-capabilities") throw new Error("Replacement setting failed")
          if (channel === "openalma:set-soul") return {soulId: "Quill", created: false}
          return {ok: true}
        })
        const actions = () => nodes(render()).find(node => node.props?.className === "image-review").props.children.filter((node: any) => node.type === "button")
        const flush = () => new Promise(resolve => setTimeout(resolve, 0))
        const pickPhoto = () => {
          nodes(render()).find(node => node.props?.type === "file" && !node.props.capture).props.onClick()
          return nodes(render()).find(node => node.props?.type === "file" && !node.props.capture).props.onChange({currentTarget: {
          files: [new File([new Uint8Array([1, 2, 3])], "fictional.png", {type: "image/png"})], value: "",
        }})}
        const settingError = () => labelledCheckbox(render(), "Microphone enabled").props.onChange({target: {checked: false}})
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
      "2026-01-08T10-17-23-2",
      false,
    )
    expect(payload).toEqual({
      imageId: "2026-01-08T10-17-23-2",
      mimeType: "image/png",
      data: "AQID",
      speakDescription: false,
    })
  })

})

describe("Video UI and allowance projection", () => {
  test("Video starts explicitly and Photos stays expanded in every call mode", async () => {
    const calls: any[] = []
    const snapshot = {configured: true, soulLoading: false, startGeneration: 1, soulId: "Quill", souls: ["Quill"],
      soulConfirmed: true, soulLocked: false, connection: "idle", callMode: "audio"}
    const render = renderPage(snapshot, async (channel, payload) => {
      calls.push({channel, payload})
      return channel === "openalma:set-soul" ? {soulId: "Quill", created: false} : {ok: true}
    })
    nodes(render()).find(node => node.props?.onFocus).props.onChange({target: {value: "Quill"}})
    await nodes(render()).find(node => node.props?.["aria-label"] === "Use soul").props.onClick()
    await new Promise(resolve => setTimeout(resolve, 0))
    calls.length = 0
    await nodes(render()).find(node => node.type === "button" && node.props.children === "Video").props.onClick()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toEqual([{channel: "openalma:start", payload: {mode: "continuous", callMode: "video"}}])
    snapshot.callMode = "video"; snapshot.connection = "listening"
    const photos = nodes(render()).find(node => node.props.className === "photo-controls")
    expect(photos.type).toBe("section")
    expect(nodes(photos).some(node => node.props?.children === "Photos")).toBe(true)
    expect(nodes(photos).filter(node => node.props?.type === "file")).toHaveLength(1)
    expect(nodes(photos).find(node => node.type === "button" && node.props.children === "Take photo")).toBeDefined()
    snapshot.callMode = "audio"
    expect(nodes(render()).find(node => node.props.className === "photo-controls").type).toBe("section")
    expect(nodes(render()).filter(node => node.props?.type === "file")).toHaveLength(2)
    snapshot.callMode = "video"
    for (const connection of ["idle", "error"]) {
      snapshot.connection = connection
      expect(nodes(render()).find(node => node.props.className === "photo-controls").type).toBe("section")
      expect(nodes(render()).filter(node => node.props?.type === "file")).toHaveLength(2)
    }
  })

  test("Video Take photo reserves the captured still and uses the deliberate upload path", async () => {
    const calls: any[] = []
    const render = renderPage({configured: true, soulId: "Quill", souls: ["Quill"], soulConfirmed: true,
      soulLocked: true, connection: "listening", callMode: "video", cameraEnabled: true}, async (channel, payload) => {
      calls.push({channel, payload})
      return channel === "openalma:reserve-image"
        ? {startGeneration: 1, imageId: "2026-01-08T10-17-23", reservationSequence: 1}
        : {ok: true}
    })
    const capture = nodes(render()).find(node => node.type === "button" && node.props.children === "Take photo")
    expect(capture.props.disabled).toBe(false)
    await capture.props.onClick()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls.map(call => call.channel)).toEqual(["openalma:save-photo", "openalma:reserve-image", "openalma:image"])
    expect(calls[0].payload).toMatchObject({creationTime: 1000, data: "/9j/"})
    expect(calls[1].payload).toMatchObject({startGeneration: 1, time: {receivedAt: 1000}})
    expect(calls[2].payload).toMatchObject({imageId: "2026-01-08T10-17-23", mimeType: "image/jpeg", data: "/9j/"})
    expect(JSON.stringify(render())).toContain("Photo sent")
  })

  test("slider coalesces slow saves, shows one value set, and blocks Start until the last save", async () => {
    const snapshot = {configured: true, soulLoading: false, soulId: "Quill", souls: ["Quill"],
      soulConfirmed: true, soulLocked: false, connection: "idle", maxMemorizedPhotos: 1}
    let release!: () => void
    const calls: any[] = []
    const render = renderPage(snapshot, async (channel, payload) => {
      if (channel === "openalma:set-soul") return {soulId: "Quill", created: false}
      calls.push({channel, payload})
      if (channel === "openalma:set-max-memorized-photos") {
        await new Promise<void>(resolve => {release = resolve})
        snapshot.maxMemorizedPhotos = payload.value
      }
      return {ok: true}
    })
    nodes(render()).find(node => node.props?.onFocus).props.onChange({target: {value: "Quill"}})
    await nodes(render()).find(node => node.props?.["aria-label"] === "Use soul").props.onClick()
    const slider = () => nodes(render()).find(node => node.props?.type === "range")
    slider().props.onChange({target: {value: "2"}})
    slider().props.onChange({target: {value: "4"}})
    slider().props.onChange({target: {value: "5"}})
    expect(slider().props.value).toBe(5)
    expect(nodes(render()).filter(node => node.type === "output")).toHaveLength(1)
    expect(nodes(render()).find(node => node.type === "output").props.children).toEqual([5, " in 5 min, ", 10, " in 15 min, ", 15, " in 45 min"])
    const start = () => nodes(render()).find(node => node.props?.className === "sitting-button")
    expect(start().props.disabled).toBe(true)
    start().props.onClick()
    expect(calls).toEqual([{channel: "openalma:set-max-memorized-photos", payload: {value: 2}}])
    release(); await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toEqual([2, 5].map(value => ({channel: "openalma:set-max-memorized-photos", payload: {value}})))
    expect(start().props.disabled).toBe(true)
    release(); await new Promise(resolve => setTimeout(resolve, 0))
    expect(slider().props.value).toBe(5)
    expect(start().props.disabled).toBe(false)
    snapshot.connection = "starting"
    expect(slider().props.disabled).toBe(true)
    snapshot.connection = "stopping"
    expect(slider().props.disabled).toBe(true)
    snapshot.connection = "listening"
    expect(slider().props.disabled).toBe(false)
    expect(JSON.stringify(render())).toContain("Changes apply to the next call.")
  })
})
