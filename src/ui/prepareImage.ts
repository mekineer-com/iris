const MAX_LONG_EDGE = 800
const JPEG_QUALITY = 0.85

export async function prepareImage(file: File): Promise<File> {
  const url = URL.createObjectURL(file)
  const image = document.createElement("img")
  let canvas: HTMLCanvasElement | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error("Could not read photo"))
      image.src = url
    })
    const width = image.naturalWidth
    const height = image.naturalHeight
    if (!width || !height) throw new Error("Photo has no image dimensions")
    const scale = Math.min(1, MAX_LONG_EDGE / Math.max(width, height))
    if (scale === 1) return file
    canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Could not prepare photo")
    context.imageSmoothingQuality = "high"
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob>((resolve, reject) => canvas!.toBlob(value =>
      value ? resolve(value) : reject(new Error("Could not encode photo")), file.type,
    file.type === "image/jpeg" ? JPEG_QUALITY : undefined))
    if (blob.type !== file.type) throw new Error("Photo encoding changed its format")
    return new File([blob], file.name, {type: file.type, lastModified: file.lastModified})
  } finally {
    image.onload = image.onerror = null
    image.src = ""
    URL.revokeObjectURL(url)
    if (canvas) canvas.width = canvas.height = 0
  }
}
