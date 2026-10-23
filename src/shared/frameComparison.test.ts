import {expect, test} from "bun:test"
import {compareFrames, type RgbFrame} from "./frameComparison"

const solid = (width: number, height: number, color = 0): RgbFrame =>
  ({width, height, data: new Uint8Array(width * height * 3).fill(color)})

// Same synthetic scene/patch construction as _tools/iris/stream_frame_compare.py.
function scene(): RgbFrame {
  const frame = solid(96, 64)
  for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
    frame.data.set([(x * 3 + y) % 160 + 40, (y * 3 + x) % 160 + 40,
      (x + y * 2) % 160 + 40], (y * frame.width + x) * 3)
  }
  return frame
}

function patch(frame: RgbFrame, left: number, top: number, width: number, height: number): RgbFrame {
  const changed = {...frame, data: frame.data.slice()}
  for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) {
    changed.data.set([220, 30, 30], (y * frame.width + x) * 3)
  }
  return changed
}

test("identical synthetic scenes score zero without changing their pixels", () => {
  const frame = scene()
  const before = frame.data.slice()
  expect(compareFrames(frame, {...frame, data: frame.data.slice()})).toEqual({wholeMean: 0, peakBlockMean: 0})
  expect(frame.data).toEqual(before)
})

test("whole/block means match the original Python's small-patch result", () => {
  const frame = scene()
  const difference = compareFrames(frame, patch(frame, 40, 24, 4, 4))!
  expect(difference.wholeMean).toBeCloseTo(0.2261284722222222, 10)
  expect(difference.peakBlockMean).toBeCloseTo(21.708333333333332, 10)
})

test("small local changes are not diluted into the whole-frame mean", () => {
  const frame = scene()
  const difference = compareFrames(frame, patch(frame, 40, 24, 1, 1))!
  expect(difference.peakBlockMean).toBeGreaterThan(difference.wholeMean * 50)
})

test("partial edge blocks count actual pixels, not padded eight-by-eight areas", () => {
  const frame = solid(9, 9)
  const changed = {...frame, data: frame.data.slice()}
  changed.data.set([255, 255, 255], (9 * 9 - 1) * 3)
  expect(compareFrames(frame, changed)).toEqual({wholeMean: 255 / 81, peakBlockMean: 255})
})

test.each([[3, 11], [11, 3], [1, 1]])("odd %ix%i geometry compares all channels", (width, height) => {
  expect(compareFrames(solid(width, height), solid(width, height, 123)))
    .toEqual({wholeMean: 123, peakBlockMean: 123})
})

test("portrait/landscape and size changes report incomparable geometry", () => {
  expect(compareFrames(solid(3, 11), solid(11, 3))).toBeNull()
  expect(compareFrames(solid(8, 8), solid(16, 8))).toBeNull()
})

test("gradual changes remain visible against a retained reference", () => {
  const reference = solid(8, 8, 80)
  for (let step = 1; step <= 12; step++) {
    expect(compareFrames(reference, solid(8, 8, 80 + step))!.peakBlockMean).toBe(step)
  }
})

test("a return to an old scene still differs from the current reference", () => {
  const a = solid(8, 8, 20), b = solid(8, 8, 90)
  expect(compareFrames(a, b)).toEqual(compareFrames(b, a))
  expect(compareFrames(b, a)!.peakBlockMean).toBe(70)
})

test.each([
  {width: 0, height: 1, data: new Uint8Array()},
  {width: 8, height: 8, data: new Uint8Array(8 * 8 * 4)},
  {width: 8, height: 8, data: new Uint8Array(3)},
])("rejects malformed or RGBA input rather than returning a false score", frame => {
  expect(() => compareFrames(frame, solid(8, 8))).toThrow("packed RGB")
  expect(() => compareFrames(solid(8, 8), frame)).toThrow("packed RGB")
})
