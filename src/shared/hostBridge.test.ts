import {describe, expect, test} from "bun:test"
import {installBackgroundBridge, installUiBridge} from "./hostBridge"

describe("host bridge normalization", () => {
  test("Glassly uses the same UI bridge and host metadata objects", async () => {
    const messages: string[] = []
    const glassly = {
      ready() {messages.push("ready")},
      request(channel: string) {messages.push(channel); return Promise.resolve({ok: true})},
    } as unknown as typeof mentra
    const metadata = {colorScheme: "dark" as const, safeAreaInsets: {top: 20, bottom: 5, left: 0, right: 0}}
    const host: Parameters<typeof installUiBridge>[0] = {glassly, Glassly: metadata}
    installUiBridge(host)
    expect(host!.mentra).toBe(glassly)
    expect(host!.MentraOS).toBe(metadata)
    host!.mentra!.ready()
    await host!.mentra!.request("openalma:stop", {})
    expect(messages).toEqual(["ready", "openalma:stop"])
    metadata.safeAreaInsets.top = 30
    expect(host!.MentraOS!.safeAreaInsets!.top).toBe(30)
  })

  test("native Mentra objects are not replaced", () => {
    const native = {} as typeof mentra
    const metadata = {colorScheme: "light" as const}
    const host = {mentra: native, MentraOS: metadata, glassly: {} as typeof mentra, Glassly: {colorScheme: "dark" as const}}
    installUiBridge(host)
    expect(host.mentra).toBe(native)
    expect(host.MentraOS).toBe(metadata)
  })

  test("background callbacks forward to the current SDK hook, including transport close/reopen", () => {
    const received: string[] = []
    const nativeInit = (id: string) => received.push(`init:${id}`)
    const host: Parameters<typeof installBackgroundBridge>[0] = {__mentraInitCallback: nativeInit}
    installBackgroundBridge(host)
    host!.__initCallback!("fictional-session")
    host!.__mentraDeliverBridgeRaw = raw => received.push(`first:${raw}`)
    host!.__deliverBridgeRaw!("one")
    delete host!.__mentraDeliverBridgeRaw
    host!.__deliverBridgeRaw!("closed")
    host!.__mentraDeliverBridgeRaw = raw => received.push(`second:${raw}`)
    host!.__deliverBridgeRaw!("two")
    expect(host!.__mentraInitCallback).toBe(nativeInit)
    expect(received).toEqual(["init:fictional-session", "first:one", "second:two"])
  })
})
