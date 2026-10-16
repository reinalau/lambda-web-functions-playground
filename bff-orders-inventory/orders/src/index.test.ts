import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// Signal the entry module not to auto-start the server on import.
process.env.NODE_ENV = "test";

// Configure a fake inventory endpoint and static credentials so the real
// inventory client can build and sign a request without hitting any network or
// real AWS. The outbound call itself is intercepted by stubbing global fetch.
process.env.INVENTORY_ENDPOINT = "https://inventory.example.on.aws";
process.env.AWS_REGION = "us-east-1";
process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLE";
process.env.AWS_SECRET_ACCESS_KEY = "secretexample";

// Stub the shared DynamoDB document client so no real AWS call is made.
const { ddb } = await import("./db.js");
let sendStub: (command: unknown) => Promise<unknown> = async () => ({});
(ddb as unknown as { send: typeof sendStub }).send = (command: unknown) =>
  sendStub(command);

// Stub global fetch so the SigV4-signed outbound call to inventory is never
// sent over the network. Each test sets the status the inventory would return.
const realFetch = globalThis.fetch;
let fetchStatus = 200;
let fetchBody: unknown = { productId: "abc", available: 10 };
globalThis.fetch = (async () =>
  new Response(JSON.stringify(fetchBody), {
    status: fetchStatus,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

const { createApp } = await import("./index.js");

let server: Server;
let baseUrl: string;

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    // Port 0 lets the OS pick a free ephemeral port.
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

test("GET /health returns 200 with a healthy status", async () => {
  const response = await realFetch(`${baseUrl}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "healthy" });
});

test("POST /orders returns 400 when the body is missing fields", async () => {
  const response = await realFetch(`${baseUrl}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId: "abc" }),
  });

  assert.equal(response.status, 400);
});

test("POST /orders returns 409 when inventory reports insufficient stock", async () => {
  // The stubbed inventory responds 409, which the client maps to
  // InsufficientStockError and the route maps to a 409 response.
  fetchStatus = 409;

  const response = await realFetch(`${baseUrl}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId: "abc", quantity: 5, customer: "alice" }),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "insufficient stock" });
});
