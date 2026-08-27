import {describe, expect, test} from "bun:test"

import {findReleaseUri, rewriteReleaseUri} from "./release-private.mjs"

describe("private release URI", () => {
  test("keeps the CLI-selected port and advertises WireGuard", () => {
    const original =
      "miniapp://release?url=http%3A%2F%2F161.132.51.34%3A6791&package=com.openalma.mentra&version=0.1.0&name=OpenAlma"
    const uri = rewriteReleaseUri(findReleaseUri(`before\n${original}\nafter`), "10.77.0.1")
    const release = new URL(uri)

    expect(release.searchParams.get("url")).toBe("http://10.77.0.1:6791")
    expect(release.searchParams.get("package")).toBe("com.openalma.mentra")
    expect(release.searchParams.get("version")).toBe("0.1.0")
  })
})
