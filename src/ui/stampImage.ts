// Copy-before-stamp layout from _tools/iris/stream_frame_realistic.py:stamp.
export function stampImage(
  original: HTMLCanvasElement | ImageBitmap | HTMLImageElement,
  imageId: string,
  maxLongEdge: number,
  page: Pick<Document, "createElement"> = document,
): HTMLCanvasElement {
  const width = "naturalWidth" in original ? original.naturalWidth : original.width
  const height = "naturalHeight" in original ? original.naturalHeight : original.height
  if (!imageId || !width || !height) throw new Error("Image and reference are required for stamping")
  if (!Number.isSafeInteger(maxLongEdge) || maxLongEdge < 1) throw new Error("Invalid model-copy size")
  const scale = Math.min(1, maxLongEdge / Math.max(width, height))
  const copy = page.createElement("canvas")
  copy.width = Math.max(1, Math.round(width * scale))
  copy.height = Math.max(1, Math.round(height * scale))
  const context = copy.getContext("2d")!
  context.imageSmoothingQuality = "high"
  context.drawImage(original, 0, 0, copy.width, copy.height)
  // Preserve the tested 28px/768px layout at the chosen model-copy resolution.
  let fontSize = Math.min(Math.round(28 * maxLongEdge / 768), copy.height - 12)
  if (fontSize < 10) throw new Error("Image is too small for its reference")
  context.font = `bold ${fontSize}px sans-serif`
  const available = copy.width - 24
  const measured = context.measureText(imageId).width
  if (measured > available) {
    fontSize = Math.floor(fontSize * available / measured)
    if (fontSize < 10) throw new Error("Image is too small for its reference")
    context.font = `bold ${fontSize}px sans-serif`
  }
  context.textBaseline = "top"
  context.fillStyle = "black"
  context.fillRect(6, 4, context.measureText(imageId).width + 12, fontSize + 8)
  context.fillStyle = "white"
  context.fillText(imageId, 12, 8)
  return copy
}
