import { test } from "node:test";
import assert from "node:assert/strict";

const ENDPOINT_VAR = "AWS_LAMBDA_HTTP_ENDPOINT";

/**
 * config.ts reads env at module-evaluation time, so each test sets the env
 * and imports the module with a fresh cache-busting query string.
 */
async function importConfig(): Promise<typeof import("./config.js")> {
  return import(`./config.js?t=${Date.now()}-${Math.random()}`);
}

test("parseHttpEndpoint parses host and port when env is set", async () => {
  process.env[ENDPOINT_VAR] = "0.0.0.0:8080";
  const { parseHttpEndpoint } = await importConfig();

  assert.deepEqual(parseHttpEndpoint(), { host: "0.0.0.0", port: 8080 });
});

test("parseHttpEndpoint falls back to 127.0.0.1:3001 when unset", async () => {
  delete process.env[ENDPOINT_VAR];
  const { parseHttpEndpoint } = await importConfig();

  assert.deepEqual(parseHttpEndpoint(), { host: "127.0.0.1", port: 3001 });
});

test("config exposes the documented defaults", async () => {
  delete process.env.AWS_REGION;
  delete process.env.INVENTORY_TABLE;
  const config = await importConfig();

  assert.equal(config.AWS_REGION, "us-east-1");
  assert.equal(config.INVENTORY_TABLE, "inventory");
});
