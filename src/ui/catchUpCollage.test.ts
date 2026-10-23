import {expect, mock, test} from "bun:test"
import {renderCatchUpCollage, type CatchUpFrame} from "./catchUpCollage"

function harness() {
  const canvases: Array<{width: number; height: number; getContext: ReturnType<typeof mock>}> = []
  const contexts: Array<any> = []
  const page = {createElement() {
    const context = {font: "", textBaseline: "", fillStyle: "", imageSmoothingQuality: "low",
      drawImage: mock(() => {}), fillRect: mock(() => {}), fillText: mock(() => {}),
      measureText(text: string) {return {width: text.length * parseInt(this.font.slice(5)) * 0.6}},
    }
    const canvas = {width: 0, height: 0, getContext: mock(() => context)}
    canvases.push(canvas)
    contexts.push(context)
    return canvas
  }}
  return {canvases, contexts, page: page as unknown as Pick<Document, "createElement">}
}

function frame(index: number, width = 640, height = 480): CatchUpFrame {
  return {imageId: `2026-01-08T10-17-${String(index).padStart(2, "0")}`,
    receivedAt: index * 1000, image: {width, height} as HTMLCanvasElement}
}

const options = {width: 960, height: 960, columns: 2 as const, gap: 6}

test("six frames render oldest-first across rows, without changing the input order or originals", () => {
  const h = harness()
  const frames = [6, 4, 2, 5, 3, 1].map(index => frame(index))
  const before = frames.map(item => ({...item, image: {...item.image}}))
  const canvas = renderCatchUpCollage(frames, options, h.page)
  expect(canvas).toBe(h.canvases[0])
  expect(canvas).toMatchObject({width: 960, height: 960})
  expect(h.contexts.slice(2).map(context => context.fillText.mock.calls[0][0]))
    .toEqual([1, 2, 3, 4, 5, 6].map(index => frame(index).imageId))
  expect(h.contexts[0].drawImage.mock.calls.map((call: unknown[]) => call.slice(1)))
    .toEqual([[6, 6], [483, 6], [6, 324], [483, 324], [6, 642], [483, 642]])
  expect(frames).toEqual(before)
})

test("nine-frame grid keeps full portrait and landscape views with plain letterboxing", () => {
  const h = harness()
  const frames = Array.from({length: 9}, (_, index) => frame(index + 1, index % 2 ? 640 : 480, index % 2 ? 480 : 640))
  renderCatchUpCollage(frames, {...options, columns: 3}, h.page)
  expect(h.contexts[1].drawImage.mock.calls[0]).toEqual([frames[0].image, 39, 0, 234, 312])
  expect(h.contexts[1].drawImage.mock.calls[1]).toEqual([frames[1].image, 0, 39, 312, 234])
  expect(h.contexts[1].fillRect).toHaveBeenCalledTimes(9)
  expect(h.contexts[1].imageSmoothingQuality).toBe("high")
  expect(h.contexts[0].drawImage.mock.calls.at(-1)?.slice(1)).toEqual([642, 642])
})

test("short batches leave blank cells instead of repeating or inventing frames", () => {
  const h = harness()
  const first = frame(1, 160, 120)
  const second = {...frame(1), imageId: `${first.imageId}-2`}
  renderCatchUpCollage([first, second], options, h.page)
  expect(h.contexts[0].drawImage).toHaveBeenCalledTimes(2)
  expect(h.contexts[1].drawImage.mock.calls[0].slice(3)).toEqual([160, 120])
  expect(h.contexts.slice(2).map(context => context.fillText.mock.calls[0][0]))
    .toEqual([first.imageId, second.imageId])
})

test("decoded dimensions, not styled image size, determine the fitted view", () => {
  const h = harness()
  const image = {width: 10, height: 10, naturalWidth: 640, naturalHeight: 480} as HTMLImageElement
  renderCatchUpCollage([{...frame(1), image}], options, h.page)
  expect(h.contexts[1].drawImage.mock.calls[0]).toEqual([image, 27.5, 0, 416, 312])
})

test.each([2, 3] as const)("%s-column 768px collage keeps suffix-bearing labels readable in their final cells", columns => {
  const h = harness()
  const frames = Array.from({length: columns * 3}, (_, index) => ({...frame(index), imageId: `${frame(index).imageId}-2`}))
  renderCatchUpCollage(frames, {...options, width: 768, height: 768, columns}, h.page)
  for (const [index, context] of h.contexts.slice(2).entries()) {
    expect(context.fillText.mock.calls[0][0]).toBe(frames[index].imageId)
    expect(parseInt(context.font.slice(5))).toBeGreaterThanOrEqual(10)
    expect(context.measureText(frames[index].imageId).width + 24).toBeLessThanOrEqual(h.canvases[index + 2].width)
  }
})

test("does not silently drop an overflowing batch or return an empty collage", () => {
  const h = harness()
  expect(() => renderCatchUpCollage([], options, h.page)).toThrow("nonempty batch")
  expect(() => renderCatchUpCollage(Array.from({length: 7}, (_, i) => frame(i)), options, h.page)).toThrow("fitting")
  expect(() => renderCatchUpCollage([{...frame(1), receivedAt: NaN}], options, h.page)).toThrow("times")
  expect(h.canvases).toHaveLength(0)
})

test("too-small output fails rather than silently losing timestamp labels", () => {
  const h = harness()
  expect(() => renderCatchUpCollage([frame(1)], {...options, width: 64, height: 64}, h.page)).toThrow("too small")
})
