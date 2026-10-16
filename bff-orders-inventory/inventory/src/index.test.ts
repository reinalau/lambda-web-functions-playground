import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// Signal the entry module not to auto-start the server on import.
process.env.NODE_ENV = "test";

// Stub the shared DynamoDB document client so no real AWS call is made. Each
// test sets `sendStub` to the behavior it needs.
const { ddb } = await import("./db.js");
let sendStub: (command: unknown) => Promise<unknown> = async () => ({});
(ddb as unknown as { send: typeof sendStub }).send = (command: unknown) =>
  sendStub(command);

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
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

test("GET /health returns 200 with a healthy status", async () => {
  const response = await fetch(`${baseUrl}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "healthy" });
});

test("POST /items/:productId/reserve returns 400 when the body is missing fields", async () => {
  const response = await fetch(`${baseUrl}/items/abc/reserve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(response.status, 400);
});

test("POST /items/:productId/reserve returns 409 when stock is insufficient", async () => {
  sendStub = async () => {
    const error = new Error("The conditional request failed");
    error.name = "ConditionalCheckFailedException";
    throw error;
  };

  const response = await fetch(`${baseUrl}/items/abc/reserve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quantity: 5 }),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "insufficient stock" });
});
