import {describe, expect, test} from "bun:test"

import {cameraProbeLabel, statusText, visibleConnection} from "./SessionPage"

describe("SessionPage state projection", () => {
  test("renders every Manual listening phase", () => {
    expect(statusText("listening", "manual", "idle")).toBe("Ready")
    expect(statusText("listening", "manual", "recording")).toBe("Recording...")
    expect(statusText("listening", "manual", "review")).toBe("Review recording")
    expect(statusText("listening", "manual", "submitted")).toBe("Waiting for Siri...")
    expect(statusText("listening", "continuous", "idle")).toBe("Listening")
    expect(statusText("reconnecting", "continuous", "idle")).toBe("Reconnecting...")
  })

  test("Stop projection overrides a pending Start", () => {
    expect(visibleConnection("idle", true, true)).toBe("stopping")
    expect(visibleConnection("error", true, false)).toBe("starting")
    expect(visibleConnection("idle", false, false)).toBe("idle")
  })

  test("phone camera probe accepts only nonempty files", () => {
    expect(cameraProbeLabel({size: 1025})).toBe("Photo selected locally (2 KB; not sent)")
    expect(cameraProbeLabel({size: 0})).toBeNull()
    expect(cameraProbeLabel(null)).toBeNull()
  })
})
