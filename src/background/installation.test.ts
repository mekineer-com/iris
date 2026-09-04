import {describe, expect, test} from "bun:test"

import {reportInstallation} from "./installation"
import type {OpenAlmaConfig} from "./openAlmaConfig"

const CONFIG: OpenAlmaConfig = {
  baseUrl: "http://10.77.0.1",
  bearer: "fictional",
  userId: "Test User",
  soulId: "Test Soul",
  deviceSessionId: "test-phone",
  packageName: "com.openalma.mentra",
  version: "0.1.0",
}

describe("installation report", () => {
  test("sends build identity once per call and a later load can retry", async () => {
    const requests: Array<{url: string; init?: RequestInit}> = []
    const statuses = [503, 200]
    const fetchFn = (async (url: string, init?: RequestInit) => {
      requests.push({url, init})
      return new Response(null, {status: statuses.shift()})
    }) as typeof fetch

    await expect(reportInstallation(CONFIG, fetchFn)).rejects.toThrow("Installation report failed (503)")
    await expect(reportInstallation(CONFIG, fetchFn)).resolves.toBeUndefined()

    expect(requests).toHaveLength(2)
    expect(requests[1].url).toBe("http://10.77.0.1/integration/mentra/installation/seen")
    expect(JSON.parse(String(requests[1].init?.body))).toEqual({
      user_id: "Test User",
      soul_id: "Test Soul",
      device_session_id: "test-phone",
      package_name: "com.openalma.mentra",
      version: "0.1.0",
    })
  })
})
