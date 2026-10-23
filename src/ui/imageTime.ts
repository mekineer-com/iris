import {Exifr} from "exifr/src/bundles/nano.mjs"
import "exifr/src/dicts/tiff-exif-keys.mjs"
import "exifr/src/file-parsers/png.mjs"

import {formatImageTimestamp} from "../shared/imageReference"
import type {ImageTime} from "../shared/types"
export type {ImageTime} from "../shared/types"

export async function readImageTime(file: Pick<File, "arrayBuffer">, receivedAt: number): Promise<ImageTime> {
  const receipt: ImageTime = {timestamp: formatImageTimestamp(receivedAt), source: "receipt", receivedAt}
  const bytes = await file.arrayBuffer()
  // EXIF-local filters work with nano; construct outside the optional-data catch to expose config errors.
  const parser = new Exifr({reviveValues: false, gps: false, ihdr: false,
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
      ...(typeof offset === "string" && /^[+-](?:[01]\d|2[0-3]):[0-5]\d$/.test(offset) ? {offset} : {})}
  }
  return receipt
}
