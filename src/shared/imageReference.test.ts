import {expect, test} from "bun:test"
import {formatImageTimestamp, nextImageReference} from "./imageReference"

const timestamp = "2026-01-08T10-17-23"

test("receipt time uses phone-local wall-clock fields, discarding only subsecond precision", () => {
  const receipt = new Date(2026, 0, 8, 10, 17, 23, 987)
  expect(formatImageTimestamp(receipt.getTime())).toBe(timestamp)
})

test.each([
  "2026:01:08 10:17:23",
  "2026-01-08T10:17:23",
  "2026-01-08T10:17:23.987",
  "2026-01-08T10:17:23+09:00",
  "2026-01-08T10:17:23-05:00",
  "2026-01-08T10:17:23Z",
  timestamp,
])("original time %s keeps its displayed date/time rather than converting timezone", value => {
  expect(formatImageTimestamp(value)).toBe(timestamp)
})

test("older original dates and leap years are independent of the current phone date", () => {
  expect(formatImageTimestamp("2000:02:29 01:02:03")).toBe("2000-02-29T01-02-03")
  expect(formatImageTimestamp("1999:12:31 23:59:59")).toBe("1999-12-31T23-59-59")
})

test.each([
  "1900:02:29 01:02:03", "2026:02:30 10:17:23", "2026:00:08 10:17:23",
  "2026:13:08 10:17:23", "2026:01:00 10:17:23", "2026:01:08 24:17:23",
  "2026:01:08 10:60:23", "2026:01:08 10:17:60", "not a date", NaN,
])("invalid metadata %s cannot silently become a different date", value => {
  expect(() => formatImageTimestamp(value)).toThrow("Invalid image timestamp")
})

test("same-second names are the timestamp, -2, then -3", () => {
  const first = nextImageReference(timestamp, 0)
  const second = nextImageReference(timestamp, first.suffix)
  const third = nextImageReference(timestamp, second.suffix)
  expect([first, second, third]).toEqual([
    {imageId: timestamp, suffix: 1},
    {imageId: `${timestamp}-2`, suffix: 2},
    {imageId: `${timestamp}-3`, suffix: 3},
  ])
})

test("a distinct second does not gain an always-present global suffix", () => {
  expect(nextImageReference("2026-01-08T10-17-24", 0).imageId).toBe("2026-01-08T10-17-24")
})

test("pending and recovered references raise this timestamp's high-water mark", () => {
  expect(nextImageReference(timestamp, 1, [timestamp, `${timestamp}-2`, `${timestamp}-7`]))
    .toEqual({imageId: `${timestamp}-8`, suffix: 8})
})

test("unrelated image IDs do not collide through substring or prefix guessing", () => {
  expect(nextImageReference(timestamp, 0, ["image-old-random", "2026-01-08T10-17-24-8",
    `${timestamp}-notes`, `${timestamp}-2-copy`]).imageId).toBe(timestamp)
})

test("returning to an old original second uses that second's saved state", () => {
  const older = "2019-06-02T12-00-00"
  expect(nextImageReference(timestamp, 0).imageId).toBe(timestamp)
  expect(nextImageReference(older, 4).imageId).toBe(`${older}-5`)
})

test("a repeated local hour with a different supplied offset still collides", () => {
  const first = formatImageTimestamp("2026-11-01T01:30:00-04:00")
  const repeated = formatImageTimestamp("2026-11-01T01:30:00-05:00")
  expect(first).toBe(repeated)
  expect(nextImageReference(repeated, 1).imageId).toBe(`${first}-2`)
})

test("consumed suffix gaps do not mutate an earlier reference", () => {
  const assigned = nextImageReference(timestamp, 0)
  const abandoned = nextImageReference(timestamp, assigned.suffix)
  const next = nextImageReference(timestamp, abandoned.suffix)
  expect(next.imageId).toBe(`${timestamp}-3`)
  expect(assigned.imageId).toBe(timestamp)
})

test.each([-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects corrupt suffix state %s", suffix => {
  expect(() => nextImageReference(timestamp, suffix)).toThrow("suffix state")
})

test("does not round an exhausted suffix into a reused reference", () => {
  expect(() => nextImageReference(timestamp, Number.MAX_SAFE_INTEGER)).toThrow("exhausted")
})

test("allocation accepts only the canonical timestamp, not raw EXIF or a suffixed ID", () => {
  expect(() => nextImageReference("2026:01:08 10:17:23", 0)).toThrow("dash-formatted")
  expect(() => nextImageReference(`${timestamp}-2`, 0)).toThrow("timestamp")
})
