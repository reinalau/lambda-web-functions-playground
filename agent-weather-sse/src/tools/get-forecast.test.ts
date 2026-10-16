import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getForecastTool } from "./get-forecast.js";
import type { ForecastResult, ForecastError } from "./get-forecast.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Replace global fetch with a stub returning a canned response. */
function stubFetch(response: Partial<Response> & { ok: boolean }): void {
  globalThis.fetch = (async () => response as Response) as typeof fetch;
}

test("get_forecast maps daily arrays into per-day objects", async () => {
  stubFetch({
    ok: true,
    json: async () => ({
      daily: {
        time: ["2024-01-01", "2024-01-02"],
        temperature_2m_max: [25, 27],
        temperature_2m_min: [15, 16],
        precipitation_probability_max: [10, 40],
        precipitation_sum: [0, 3.2],
        weathercode: [1, 61],
      },
    }),
  });

  const result = (await getForecastTool.invoke({
    latitude: -34.6,
    longitude: -58.38,
    days: 2,
  })) as ForecastResult;

  assert.equal(result.days.length, 2);
  assert.deepEqual(result.days[0], {
    date: "2024-01-01",
    temperatureMax: 25,
    temperatureMin: 15,
    precipitationProbabilityMax: 10,
    precipitationSum: 0,
    weatherCode: 1,
  });
  assert.equal(result.days[1].weatherCode, 61);
});

test("get_forecast returns upstream_failure on non-ok HTTP", async () => {
  stubFetch({ ok: false, status: 500, json: async () => ({}) });

  const result = (await getForecastTool.invoke({
    latitude: 0,
    longitude: 0,
  })) as ForecastError;

  assert.equal(result.error, "upstream_failure");
  assert.match(result.detail, /500/);
});

test("get_forecast returns upstream_failure on network error", async () => {
  globalThis.fetch = (async () => {
    throw new Error("timeout");
  }) as typeof fetch;

  const result = (await getForecastTool.invoke({
    latitude: 0,
    longitude: 0,
  })) as ForecastError;

  assert.equal(result.error, "upstream_failure");
  assert.match(result.detail, /timeout/);
});
