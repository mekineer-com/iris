import {expect, test} from "bun:test"
import {readFileSync} from "node:fs"
import {readImageTime} from "./imageTime"
import {formatImageTimestamp, nextImageReference} from "../shared/imageReference"

const receipt = new Date(2026, 9, 22, 13, 14, 15).getTime()
// Fictional 16x16 gray JPEG/PNG files generated with Pillow; no personal images.
function fixture(name: string) {
  const bytes = readFileSync(new URL(`./fixtures/imageTime/${name}`, import.meta.url))
  return new File([bytes], name, {type: name.endsWith("png") ? "image/png" : "image/jpeg",
    lastModified: new Date(2001, 0, 1).getTime()})
}

test.each(["capture.jpg", "capture.png"])("reads actual %s capture metadata without converting its offset", async name => {
  const file = fixture(name)
  const before = new Uint8Array(await file.arrayBuffer())
  expect(await readImageTime(file, receipt)).toEqual({timestamp: "2026-01-08T10-17-23",
    source: "DateTimeOriginal", receivedAt: receipt, originalTime: "2026:01:08 10:17:23", offset: "-05:00"})
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(before)
})

test("preserves an original date with no supplied timezone", async () => {
  expect(await readImageTime(fixture("no-zone.jpg"), receipt)).toEqual({timestamp: "2000-02-29T01-02-03",
    source: "DateTimeOriginal", receivedAt: receipt, originalTime: "2000:02:29 01:02:03"})
})

test("invalid offset metadata does not discard a usable original date", async () => {
  const bytes = new Uint8Array(await fixture("capture.jpg").arrayBuffer())
  const offset = new TextEncoder().encode("-05:00")
  const start = bytes.findIndex((_, index) => offset.every((value, part) => bytes[index + part] === value))
  expect(start).toBeGreaterThan(-1)
  bytes.set(new TextEncoder().encode("broken"), start)
  expect(await readImageTime(new File([bytes], "invalid-offset.jpg"), receipt)).toEqual({
    timestamp: "2026-01-08T10-17-23", source: "DateTimeOriginal", receivedAt: receipt,
    originalTime: "2026:01:08 10:17:23",
  })
})

test("the existing parser normalizes padded and NUL-terminated metadata at its boundary", async () => {
  expect(await readImageTime(fixture("padded.jpg"), receipt)).toEqual({timestamp: "2026-01-08T10-17-23",
    source: "DateTimeOriginal", receivedAt: receipt, originalTime: "2026:01:08 10:17:23", offset: "-05:00"})
})

test("uses valid creation metadata if original capture metadata is unusable", async () => {
  expect(await readImageTime(fixture("creation.jpg"), receipt)).toEqual({timestamp: "2019-06-02T12-00-00",
    source: "CreateDate", receivedAt: receipt, originalTime: "2019:06:02 12:00:00", offset: "+09:00"})
})

test.each(["no-date.jpg", "no-date.png", "bad-date.jpg"])("%s uses receipt time, never file modification time", async name => {
  expect(await readImageTime(fixture(name), receipt)).toEqual({timestamp: formatImageTimestamp(receipt),
    source: "receipt", receivedAt: receipt})
})

test("unreadable optional metadata keeps honest receipt provenance", async () => {
  expect(await readImageTime(new File([new Uint8Array([0xff, 0xd8, 0xff])], "truncated.jpg"), receipt))
    .toEqual({timestamp: formatImageTimestamp(receipt), source: "receipt", receivedAt: receipt})
})

test("failure to read the file is not hidden as missing metadata", async () => {
  const file = {arrayBuffer: async (): Promise<ArrayBuffer> => {throw new Error("File unavailable")}}
  await expect(readImageTime(file, receipt)).rejects.toThrow("File unavailable")
})

test("two formats with the same original second use the agreed collision suffix", async () => {
  const a = await readImageTime(fixture("capture.jpg"), receipt)
  const b = await readImageTime(fixture("capture.png"), receipt + 60_000)
  expect(a.timestamp).toBe(b.timestamp)
  const first = nextImageReference(a.timestamp, 0)
  expect(nextImageReference(b.timestamp, first.suffix).imageId).toBe(`${first.imageId}-2`)
})
