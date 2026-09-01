import {describe, expect, test} from "bun:test"

import {imageRequest, newImageId, statusText, validateImageFile, visibleConnection} from "./SessionPage"

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

  test("accepts only bounded JPEG and PNG files", () => {
    expect(validateImageFile({size: 80_000, type: "image/jpeg"})).toBe("image/jpeg")
    expect(() => validateImageFile({size: 0, type: "image/png"})).toThrow("between 1 byte and 1 MB")
    expect(() => validateImageFile({size: 12, type: "image/webp"})).toThrow("JPEG or PNG")
  })

  test("encodes one validated file for the image RPC", async () => {
    const payload = await imageRequest(
      new File([new Uint8Array([1, 2, 3])], "photo.png", {type: "image/png"}),
      "image-1",
      false,
    )
    expect(payload).toEqual({
      imageId: "image-1",
      mimeType: "image/png",
      data: "AQID",
      speakDescription: false,
    })
  })

  test("creates an image id without secure-context crypto", () => {
    expect(newImageId(1234, 0.5)).toBe("image-ya-i")
  })
})
