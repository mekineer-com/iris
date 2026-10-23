import {Exifr} from "exifr/src/bundles/nano.mjs"
import "exifr/src/dicts/tiff-exif-keys.mjs"
import "exifr/src/file-parsers/png.mjs"
import "exifr/src/segment-parsers/ihdr.mjs"

import {formatImageTimestamp} from "../shared/imageReference"

export interface ImageTime {
  timestamp: string
  source: "DateTimeOriginal" | "CreateDate" | "receipt"
  receivedAt: number
  originalTime?: string
  offset?: string
}

export async function readImageTime(file: Pick<File, "arrayBuffer">, receivedAt: number): Promise<ImageTime> {
  const receipt: ImageTime = {timestamp: formatImageTimestamp(receivedAt), source: "receipt", receivedAt}
  const bytes = await file.arrayBuffer()
  // EXIF-local filters work with nano; construct outside the optional-data catch to expose config errors.
  const parser = new Exifr({reviveValues: false, gps: false,
    ifd0: {pick: [0x8769]}, exif: {pick: [0x9003, 0x9004, 0x9011, 0x9012]}})
  let metadata: unknown
  try {
    await parser.read(bytes)
    metadata = await parser.parse()
  } catch {
    // Optional metadata may be absent/damaged; failure to read the file itself still propagates.
    return receipt
  }
  if (!metadata || typeof metadata !== "object") return receipt
  const fields = metadata as Record<string, unknown>
  for (const [source, offsetField] of [
    ["DateTimeOriginal", "OffsetTimeOriginal"], ["CreateDate", "OffsetTimeDigitized"],
  ] as const) {
    const originalTime = fields[source]
    if (typeof originalTime !== "string") continue
    let timestamp: string
    try {timestamp = formatImageTimestamp(originalTime)} catch {continue}
    const offset = fields[offsetField]
    return {timestamp, source, receivedAt, originalTime,
      ...(typeof offset === "string" && offset ? {offset} : {})}
  }
  return receipt
}
