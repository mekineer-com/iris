import {describe, expect, test} from "bun:test"
import {readFileSync} from "node:fs"
import {join} from "node:path"

describe("miniapp manifest", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../../miniapp.json"), "utf8"))

  test("locks identity, entry, permissions, and hardware", () => {
    expect(manifest.packageName).toBe("com.openalma.mentra")
    expect(manifest.version).toBe("0.1.0")
    expect(manifest.port).toBe(3141)
    expect(manifest.minHostVersion).toBe("2.13.0")
    expect(manifest.sdkVersion).toBe("0.3.0")
    expect(manifest.entry).toEqual({
      background: "background/index.js",
      ui: "ui/index.html",
    })
    expect(manifest.permissions.map((row: {type: string}) => row.type)).toEqual(["MICROPHONE"])
    expect(manifest.hardwareRequirements.map((row: {type: string; level: string}) => [row.type, row.level])).toEqual([
      ["MICROPHONE", "REQUIRED"],
      ["SPEAKER", "REQUIRED"],
    ])
  })
})
