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
  const result = stampImage(h.original as unknown as HTMLCanvasElement, reference, 768, h.page)
  expect(result).toBe(h.copy)
  expect(h.copy).toMatchObject({width: 768, height: 512})
  expect(h.context.drawImage).toHaveBeenCalledWith(h.original, 0, 0, 768, 512)
  expect(h.context.fillText).toHaveBeenCalledWith(reference, 12, 8)
  expect(h.context.fillRect).toHaveBeenCalledTimes(1)
  expect(h.context.fillStyle).toBe("white")
  expect(h.original.pixels).toEqual(before)
})

test("fits the full suffix-bearing reference inside a portrait model copy", () => {
  const h = harness(300, 768)
  stampImage(h.original as unknown as HTMLCanvasElement, reference, 768, h.page)
  expect(parseInt(h.context.font.slice(5))).toBeLessThan(28)
  expect(h.context.measureText(reference).width + 24).toBeLessThanOrEqual(300)
  expect(h.context.fillText.mock.calls[0][0]).toBe(reference)
})

test("fits a readable reference on a 256px original without upscaling it", () => {
  const h = harness(256, 256)
  stampImage(h.original as unknown as HTMLCanvasElement, reference, 768, h.page)
  expect(h.copy).toMatchObject({width: 256, height: 256})
  expect(parseInt(h.context.font.slice(5))).toBeGreaterThanOrEqual(10)
  expect(h.context.measureText(reference).width + 24).toBeLessThanOrEqual(256)
  expect(h.context.fillText).toHaveBeenCalledWith(reference, 12, 8)
})

test("uses decoded image dimensions rather than a styled preview size", () => {
  const h = harness()
  const image = {...h.original, width: 100, height: 50, naturalWidth: 640, naturalHeight: 480}
  stampImage(image as unknown as HTMLImageElement, reference, 768, h.page)
  expect(h.copy).toMatchObject({width: 640, height: 480})
})

test("shrinks the label to fit image height as well as width", () => {
  const h = harness(768, 30)
  stampImage(h.original as unknown as HTMLCanvasElement, reference, 768, h.page)
  expect(parseInt(h.context.font.slice(5))).toBeLessThanOrEqual(18)
})

test("does not silently produce an unlabeled image when no readable label can fit", () => {
  const h = harness(128, 128)
  expect(() => stampImage(h.original as unknown as HTMLCanvasElement, reference, 768, h.page)).toThrow("too small")
})

test("requires a decoded image and an assigned reference", () => {
  const h = harness(0, 0)
  expect(() => stampImage(h.original as unknown as HTMLCanvasElement, reference, 768, h.page)).toThrow("required")
})

test.each([[4032, 3024, 768, 576], [4000, 6000, 512, 768]])(
  "scales %sx%s originals before allocating and stamping the model copy", (width, height, outWidth, outHeight) => {
    const h = harness(width, height)
    stampImage(h.original as unknown as HTMLCanvasElement, reference, 768, h.page)
    expect(h.copy).toMatchObject({width: outWidth, height: outHeight})
    expect(h.context.drawImage).toHaveBeenCalledWith(h.original, 0, 0, outWidth, outHeight)
    expect(h.context.font).toBe("bold 28px sans-serif")
    expect(h.context.fillText).toHaveBeenCalledWith(reference, 12, 8)
    expect(h.original).toMatchObject({width, height})
  },
)

test("scales the label with the explicitly chosen output size", () => {
  const h = harness(4032, 3024)
  stampImage(h.original as unknown as HTMLCanvasElement, reference, 1536, h.page)
  expect(h.copy).toMatchObject({width: 1536, height: 1152})
  expect(h.context.font).toBe("bold 56px sans-serif")
})
