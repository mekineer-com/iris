import {stampImage} from "./stampImage"

export interface CatchUpFrame {
  image: Parameters<typeof stampImage>[0]
  imageId: string
  receivedAt: number
}

export interface CatchUpCollageOptions {
  width: number
  height: number
  columns: 2 | 3
  gap: number
}

// The caller selects the batch and owns its interval, delivery and originals.
export function renderCatchUpCollage(
  frames: readonly CatchUpFrame[],
  {width, height, columns, gap}: CatchUpCollageOptions,
  page: Pick<Document, "createElement"> = document,
): HTMLCanvasElement {
  if (!frames.length || frames.length > columns * 3) throw new Error("Expected a nonempty batch fitting the collage")
  if (![width, height, gap].every(Number.isSafeInteger) || gap < 0 ||
      !frames.every(frame => Number.isFinite(frame.receivedAt))) throw new Error("Invalid collage dimensions or times")
  const cellWidth = Math.floor((width - gap * (columns + 1)) / columns)
  const cellHeight = Math.floor((height - gap * 4) / 3)
  if (cellWidth < 1 || cellHeight < 1) throw new Error("Collage cells are too small")
  const collage = page.createElement("canvas")
  collage.width = width
  collage.height = height
  const context = collage.getContext("2d")!
  context.fillStyle = "black"
  context.fillRect(0, 0, width, height)
  const cell = page.createElement("canvas")
  cell.width = cellWidth
  cell.height = cellHeight
  const cellContext = cell.getContext("2d")!
  cellContext.imageSmoothingQuality = "high"
  for (const [index, frame] of [...frames].sort((a, b) => a.receivedAt - b.receivedAt).entries()) {
    const imageWidth = "naturalWidth" in frame.image ? frame.image.naturalWidth : frame.image.width
    const imageHeight = "naturalHeight" in frame.image ? frame.image.naturalHeight : frame.image.height
    if (!imageWidth || !imageHeight) throw new Error("Collage frame is not decoded")
    const scale = Math.min(1, cellWidth / imageWidth, cellHeight / imageHeight)
    const drawWidth = imageWidth * scale
    const drawHeight = imageHeight * scale
    cellContext.fillStyle = "black"
    cellContext.fillRect(0, 0, cellWidth, cellHeight)
    cellContext.drawImage(frame.image, (cellWidth - drawWidth) / 2, (cellHeight - drawHeight) / 2, drawWidth, drawHeight)
    // Fit text at final cell size, not before shrinking the whole collage.
    const stamped = stampImage(cell, frame.imageId, Math.max(width, height), page)
    context.drawImage(stamped, gap + index % columns * (cellWidth + gap),
      gap + Math.floor(index / columns) * (cellHeight + gap))
  }
  return collage
}
