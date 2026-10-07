import {describe, expect, test} from "bun:test"

import {parseOpenAlmaProfile, serializeOpenAlmaProfile} from "./openAlmaConfig"

describe("OpenAlma profile", () => {
  test("validates and serializes one phone-local profile", () => {
    const config = parseOpenAlmaProfile({
      baseUrl: "http://10.77.0.1///",
      userId: "Test User",
      soulId: "Test Soul",
      deviceSessionId: "test-phone",
    })
    expect(config).toMatchObject({baseUrl: "http://10.77.0.1", packageName: "com.openalma.mentra"})
    expect(JSON.parse(serializeOpenAlmaProfile(config))).toEqual({
      baseUrl: "http://10.77.0.1", userId: "Test User", deviceSessionId: "test-phone",
    })
    expect(parseOpenAlmaProfile(serializeOpenAlmaProfile(config))).toEqual(config)
  })

  test("rejects incomplete or unsafe profiles", () => {
    expect(() => parseOpenAlmaProfile(null)).toThrow("profile is invalid")
    expect(() => parseOpenAlmaProfile({baseUrl: "https://user@example.com"})).toThrow("baseUrl")
    expect(() => parseOpenAlmaProfile({
      baseUrl: "https://example.com",
      userId: "Test User",
      soulId: "Test Soul",
      deviceSessionId: "bad id",
    })).toThrow("deviceSessionId")
  })
})
