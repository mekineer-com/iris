import {expect, mock, test} from "bun:test"
import {stampImage} from "./stampImage"

function harness(width = 768, height = 512) {
  const original = {width, height, pixels: new Uint8Array([10, 20, 30])}
  const context = {font: "", textBaseline: "", fillStyle: "",
    drawImage: mock(() => {}), fillRect: mock(() => {}), fillText: mock(() => {}),
    measureText(text: string) {return {width: text.length * parseInt(this.font.slice(5)) * 0.6}},
  }
  const copy = {width: 0, height: 0, getContext: mock(() => context)}
  const page = {createElement: mock(() => copy)}
  return {original, copy, context, page: page as unknown as Pick<Document, "createElement">}
}

const reference = "2026-01-08T10-17-23-2"

test("stamps a separate copy with the complete reference, preserving original pixels", () => {
  const h = harness()
  const before = h.original.pixels.slice()
  const result = stampImage(h.original as unknown as HTMLCanvasElement, reference, h.page)
  expect(result).toBe(h.copy)
  expect(h.copy).toMatchObject({width: 768, height: 512})
  expect(h.context.drawImage).toHaveBeenCalledWith(h.original, 0, 0)
  expect(h.context.fillText).toHaveBeenCalledWith(reference, 12, 8)
  expect(h.context.fillRect).toHaveBeenCalledTimes(1)
  expect(h.context.fillStyle).toBe("white")
  expect(h.original.pixels).toEqual(before)
})

test("fits the full suffix-bearing reference inside a portrait image", () => {
  const h = harness(160, 300)
  stampImage(h.original as unknown as HTMLCanvasElement, reference, h.page)
  expect(parseInt(h.context.font.slice(5))).toBeLessThan(28)
  expect(h.context.measureText(reference).width + 24).toBeLessThanOrEqual(160)
  expect(h.context.fillText.mock.calls[0][0]).toBe(reference)
})

test("uses decoded image dimensions rather than a styled preview size", () => {
  const h = harness()
  const image = {...h.original, width: 100, height: 50, naturalWidth: 640, naturalHeight: 480}
  stampImage(image as unknown as HTMLImageElement, reference, h.page)
  expect(h.copy).toMatchObject({width: 640, height: 480})
})

test("shrinks the label to fit image height as well as width", () => {
  const h = harness(768, 30)
  stampImage(h.original as unknown as HTMLCanvasElement, reference, h.page)
  expect(parseInt(h.context.font.slice(5))).toBeLessThanOrEqual(18)
})

test("does not silently produce an unlabeled image when no readable label can fit", () => {
  const h = harness(16, 16)
  expect(() => stampImage(h.original as unknown as HTMLCanvasElement, reference, h.page)).toThrow("too small")
})

test("requires a decoded image and an assigned reference", () => {
  const h = harness(0, 0)
  expect(() => stampImage(h.original as unknown as HTMLCanvasElement, reference, h.page)).toThrow("required")
})
