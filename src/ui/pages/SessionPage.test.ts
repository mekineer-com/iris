import {describe, expect, test} from "bun:test"
import {readFileSync} from "node:fs"
import {runInNewContext} from "node:vm"
import ts from "typescript"
import * as jsx from "react/jsx-runtime"

import {
  imageRequest,
  newImageId,
  shouldWarnLargeImage,
  validateImageFile,
  visibleConnection,
} from "./SessionPage"

describe("SessionPage state projection", () => {

  test("asks only on creation, defers creation to Start, and leaves existing selection unnamed", async () => {
    const states: unknown[] = []
    let cursor = 0
    const calls: Array<{channel: string; payload: unknown}> = []
    const react = {
      useState(initial: unknown) {
        const index = cursor++
        if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial
        return [states[index], (value: unknown) => { states[index] = typeof value === "function" ? value(states[index]) : value }]
      },
      useEffect() {}, useRef: (value: unknown) => ({current: value}),
    }
    const context = {
      exports: {}, localStorage: {getItem: () => null},
      require: (name: string) => {
        if (name === "react") return react
        if (name === "react/jsx-runtime") return jsx
        if (name.endsWith("/useChannel")) return {useChannel: () => ({configured: true, soulLoading: false, soulId: "Quill", souls: ["Quill"], soulConfirmed: true, soulLocked: false})}
        if (name === "@mentra/miniapp/ui") return {useRpc: (channel: string) => async (payload: {soulId?: string}) => {
          calls.push({channel, payload})
          return channel === "openalma:set-soul" ? {soulId: payload.soulId, created: payload.soulId !== "Quill"} : {ok: true}
        }}
        return {default: "", __esModule: true}
      },
    }
    const source = readFileSync(new URL("./SessionPage.tsx", import.meta.url), "utf8")
    runInNewContext(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}}).outputText, context)
    type Node = {props: Record<string, any>}
    const render = () => { cursor = 0; return (context.exports as {default: () => Node}).default() }
    const nodes = (tree: any): Node[] => !tree || typeof tree !== "object" ? []
      : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]
    const soulInput = (tree: Node) => nodes(tree).find(node => node.props?.onFocus && node.props?.value !== undefined)!
    const arrow = (tree: Node) => nodes(tree).find(node => node.props?.["aria-label"] === "Use soul")!
    const start = (tree: Node) => nodes(tree).find(node => node.props?.className === "sitting-button")!
    const human = (tree: Node) => nodes(tree).find(node => node.props?.required && node.props?.value !== undefined)

    soulInput(render()).props.onChange({target: {value: "Fable"}})
    await arrow(render()).props.onClick()
    expect(calls).toEqual([])
    expect(human(render())).toBeDefined()
    await start(render()).props.onClick()
    expect(calls).toEqual([])
    human(render())!.props.onChange({target: {value: " Rowan "}})
    expect(start(render()).props.disabled).toBe(false)
    await start(render()).props.onClick()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toEqual([
      {channel: "openalma:set-soul", payload: {soulId: "Fable", useExisting: false, userName: "Rowan"}},
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
