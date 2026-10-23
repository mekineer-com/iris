// Formatting an image ID does not convert its timezone; callers retain time/provenance metadata.
export function formatImageTimestamp(time: number | string): string {
  let parts: number[]
  if (typeof time === "number") {
    const date = new Date(time)
    parts = [date.getFullYear(), date.getMonth() + 1, date.getDate(),
      date.getHours(), date.getMinutes(), date.getSeconds()]
  } else {
    const match = /^(\d{4})[:-](\d{2})[:-](\d{2})[T ](\d{2})[:-](\d{2})[:-](\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.exec(time)
    if (!match) throw new Error("Invalid image timestamp")
    parts = match.slice(1, 7).map(Number)
  }
  const [year, month, day, hour, minute, second] = parts
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (!parts.every(Number.isInteger) || year < 1 || year > 9999 || month < 1 || month > 12 ||
      day < 1 || day > days[month - 1] || hour < 0 || hour > 23 ||
      minute < 0 || minute > 59 || second < 0 || second > 59) {
    throw new Error("Invalid image timestamp")
  }
  const [y, m, d, h, min, sec] = parts.map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
  return `${y}-${m}-${d}T${h}-${min}-${sec}`
}

export interface ImageReference {
  imageId: string
  suffix: number
}

// Supply this timestamp's persisted high-water mark, not a counter reset at each Start.
// The background must persist the returned suffix before publishing/uploading the reference.
export function nextImageReference(timestamp: string, lastSuffix: number, knownIds: Iterable<string> = []): ImageReference {
  if (timestamp !== formatImageTimestamp(timestamp)) throw new Error("Expected a dash-formatted image timestamp")
  if (!Number.isSafeInteger(lastSuffix) || lastSuffix < 0) throw new Error("Invalid image suffix state")
  let suffix = lastSuffix
  for (const imageId of knownIds) {
    if (imageId === timestamp) suffix = Math.max(suffix, 1)
    else if (imageId.startsWith(`${timestamp}-`)) {
      const tail = imageId.slice(timestamp.length + 1)
      if (!/^[1-9]\d*$/.test(tail)) continue
      const used = Number(tail)
      if (!Number.isSafeInteger(used)) throw new Error("Invalid image suffix state")
      suffix = Math.max(suffix, used)
    }
  }
  suffix++
  if (!Number.isSafeInteger(suffix)) throw new Error("Image suffix exhausted")
  return {imageId: suffix === 1 ? timestamp : `${timestamp}-${suffix}`, suffix}
}
