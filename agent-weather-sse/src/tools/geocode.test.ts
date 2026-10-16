import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { geocodeTool } from "./geocode.js";
import type { GeocodeResult, GeocodeError } from "./geocode.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Replace global fetch with a stub returning a canned response. */
function stubFetch(response: Partial<Response> & { ok: boolean }): void {
  globalThis.fetch = (async () => response as Response) as typeof fetch;
}

test("geocode maps the first result on success", async () => {
  stubFetch({
    ok: true,
    json: async () => ({
      results: [
        {
          latitude: -34.6,
          longitude: -58.38,
          name: "Buenos Aires",
          country: "Argentina",
        },
      ],
    }),
  });

  const result = (await geocodeTool.invoke({
    city: "Buenos Aires",
  })) as GeocodeResult;

  assert.deepEqual(result, {
    latitude: -34.6,
    longitude: -58.38,
    name: "Buenos Aires",
    country: "Argentina",
  });
});

test("geocode returns city_not_found when there are no results", async () => {
  stubFetch({ ok: true, json: async () => ({ results: [] }) });

  const result = (await geocodeTool.invoke({
    city: "Nowhereville",
  })) as GeocodeError;

  assert.deepEqual(result, { error: "city_not_found", city: "Nowhereville" });
});

test("geocode returns upstream_failure on non-ok HTTP", async () => {
  stubFetch({ ok: false, status: 503, json: async () => ({}) });

  const result = (await geocodeTool.invoke({ city: "Paris" })) as GeocodeError;

  assert.equal(result.error, "upstream_failure");
  assert.match(result.detail ?? "", /503/);
});

test("geocode returns upstream_failure on network error", async () => {
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;

  const result = (await geocodeTool.invoke({ city: "Paris" })) as GeocodeError;

  assert.equal(result.error, "upstream_failure");
  assert.match(result.detail ?? "", /network down/);
});
