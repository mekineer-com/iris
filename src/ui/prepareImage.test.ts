import {describe, expect, test} from "bun:test"
import {readFileSync} from "node:fs"
import {runInNewContext} from "node:vm"
import ts from "typescript"

function harness(width: number, height: number, failure?: "decode" | "encode" | "format") {
  const draws: number[][] = []
  const encodings: Array<{type: string; quality?: number}> = []
  const revoked: string[] = []
  const context = {imageSmoothingQuality: "", drawImage: (_: unknown, ...args: number[]) => draws.push(args)}
  const canvas = {width: 0, height: 0, getContext: () => context,
    toBlob(callback: (blob: Blob | null) => void, type: string, quality?: number) {
      encodings.push({type, quality})
      callback(failure === "encode" ? null : new Blob(["prepared"], {
        type: failure === "format" ? "image/png" : type,
      }))
    },
  }
  const image = {naturalWidth: width, naturalHeight: height,
    onload: null as (() => void) | null, onerror: null as (() => void) | null,
    set src(value: string) {if (value) queueMicrotask(() => failure === "decode" ? this.onerror?.() : this.onload?.())},
  }
  const globals = {exports: {}, File, Promise, Error,
    URL: {createObjectURL: () => "blob:original", revokeObjectURL: (url: string) => revoked.push(url)},
    document: {createElement: (tag: string) => tag === "img" ? image : canvas},
  }
  const source = readFileSync(new URL("./prepareImage.ts", import.meta.url), "utf8")
  runInNewContext(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText, globals)
  return {prepare: (globals.exports as {prepareImage: (file: File) => Promise<File>}).prepareImage,
    draws, encodings, canvas, revoked, context}
}

describe("photo preparation", () => {
  test("returns the original File without encoding or enlargement when within bounds", async () => {
    const h = harness(800, 600)
    const file = new File(["original"], "small.png", {type: "image/png"})
    expect(await h.prepare(file)).toBe(file)
    expect(h.encodings).toEqual([])
    expect(h.revoked).toEqual(["blob:original"])
  })

  test.each([[6000, 4000, 2048, 1365], [4000, 6000, 1365, 2048]])(
    "scales %sx%s without changing filename, type or file date", async (width, height, outWidth, outHeight) => {
      const h = harness(width, height)
      const file = new File(["original"], "camera.jpg", {type: "image/jpeg", lastModified: 1000})
      const result = await h.prepare(file)
      expect(result).not.toBe(file)
      expect(result.name).toBe(file.name)
      expect(result.lastModified).toBe(1000)
      expect(result.type).toBe("image/jpeg")
      expect(await result.text()).toBe("prepared")
      expect(await file.text()).toBe("original")
      expect(h.draws).toEqual([[0, 0, outWidth, outHeight]])
      expect(h.encodings).toEqual([{type: "image/jpeg", quality: 0.85}])
      expect(h.context.imageSmoothingQuality).toBe("high")
      expect(h.canvas.width).toBe(0)
      expect(h.canvas.height).toBe(0)
      expect(h.revoked).toEqual(["blob:original"])
    },
  )

  test("keeps PNG encoding without painting a background or applying JPEG quality", async () => {
    const h = harness(3000, 2000)
    const result = await h.prepare(new File(["png"], "alpha.png", {type: "image/png"}))
    expect(result.type).toBe("image/png")
    expect(h.encodings).toEqual([{type: "image/png", quality: undefined}])
  })

  test.each(["decode", "encode", "format"] as const)("rejects %s failures and releases resources", async failure => {
    const h = harness(3000, 2000, failure)
    await expect(h.prepare(new File(["jpeg"], "photo.jpg", {type: "image/jpeg"}))).rejects.toThrow()
    expect(h.revoked).toEqual(["blob:original"])
    expect(h.canvas.width).toBe(0)
    expect(h.canvas.height).toBe(0)
  })
})
