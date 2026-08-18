import {describe, expect, test} from "bun:test"
import {readFileSync, readdirSync, statSync} from "node:fs"
import {join} from "node:path"

const root = join(import.meta.dir, "../..")
const banned = /elevenlabs|signed-url|getElevenLabsConfig|tailwind|radix|cva|clsx/i

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, acc)
    else if (/\.(ts|tsx|mjs|json|css|html|md)$/.test(name)) acc.push(path)
  }
  return acc
}

describe("strip list", () => {
  test("repo text has no forbidden symbols", () => {
    const hits: string[] = []
    for (const path of walk(root)) {
      if (path.endsWith("strip.test.ts")) continue
      const text = readFileSync(path, "utf8")
      if (banned.test(text)) hits.push(path.replace(root + "/", ""))
    }
    expect(hits).toEqual([])
  })
})
