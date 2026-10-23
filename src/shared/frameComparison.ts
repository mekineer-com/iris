export interface RgbFrame {
  width: number
  height: number
  data: Uint8Array
}

export interface FrameDifference {
  wholeMean: number
  peakBlockMean: number
}

// Port of _tools/iris/stream_frame_compare.py:scores; edge blocks use their actual area.
export function compareFrames(previous: RgbFrame, current: RgbFrame): FrameDifference | null {
  for (const frame of [previous, current]) {
    if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height) ||
        frame.width <= 0 || frame.height <= 0 || frame.data.length !== frame.width * frame.height * 3) {
      throw new Error("Expected a nonempty, packed RGB frame")
    }
  }
  // Geometry changes need a new reference, not a comparison between unrelated coordinates.
  if (previous.width !== current.width || previous.height !== current.height) return null

  const {width, height} = current
  let whole = 0
  let peakBlockMean = 0
  for (let top = 0; top < height; top += 8) {
    for (let left = 0; left < width; left += 8) {
      const bottom = Math.min(top + 8, height)
      const right = Math.min(left + 8, width)
      let block = 0
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const offset = (y * width + x) * 3
          for (let channel = 0; channel < 3; channel++) {
            block += Math.abs(previous.data[offset + channel] - current.data[offset + channel])
          }
        }
      }
      whole += block
      peakBlockMean = Math.max(peakBlockMean, block / ((bottom - top) * (right - left) * 3))
    }
  }
  return {wholeMean: whole / current.data.length, peakBlockMean}
}
