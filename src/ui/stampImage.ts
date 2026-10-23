// Copy-before-stamp layout from _tools/iris/stream_frame_realistic.py:stamp.
export function stampImage(
  original: HTMLCanvasElement | ImageBitmap | HTMLImageElement,
  imageId: string,
  page: Pick<Document, "createElement"> = document,
): HTMLCanvasElement {
  const width = "naturalWidth" in original ? original.naturalWidth : original.width
  const height = "naturalHeight" in original ? original.naturalHeight : original.height
  if (!imageId || !width || !height) throw new Error("Image and reference are required for stamping")
  const copy = page.createElement("canvas")
  copy.width = width
  copy.height = height
  const context = copy.getContext("2d")!
  context.drawImage(original, 0, 0)
  let fontSize = Math.min(28, height - 12)
  if (fontSize < 1) throw new Error("Image is too small for its reference")
  context.font = `bold ${fontSize}px sans-serif`
  const available = copy.width - 24
  const measured = context.measureText(imageId).width
  if (measured > available) {
    fontSize = Math.floor(fontSize * available / measured)
    if (fontSize < 1) throw new Error("Image is too small for its reference")
    context.font = `bold ${fontSize}px sans-serif`
  }
  context.textBaseline = "top"
  context.fillStyle = "black"
  context.fillRect(6, 4, context.measureText(imageId).width + 12, fontSize + 8)
  context.fillStyle = "white"
  context.fillText(imageId, 12, 8)
  return copy
}
