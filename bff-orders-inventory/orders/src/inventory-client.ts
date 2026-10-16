/**
 * SigV4-signed client for the downstream inventory Lambda Web Function.
 *
 * The inventory endpoint uses IamAuth, so every call must be signed with AWS
 * SigV4. This recipe is CONFIRMED against the Lambda Web Functions
 * endpoint-access-control documentation:
 *   https://docs.aws.amazon.com/lambda/latest/dg/web-functions-endpoint-access-control.html
 *
 * Key rules honored here:
 *   - The signing service name is 'lambda' and the region is the endpoint
 *     region (AWS_REGION).
 *   - EVERY signed request MUST include the X-Amz-Content-SHA256 header set to
 *     the hex SHA-256 of the request body. Lambda uses this header as the
 *     payload hash and does not read the body to recompute it.
 *   - The caller's execution role needs lambda:InvokeWebFunctionEndpoint on the
 *     inventory endpoint ARN.
 */
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { HttpRequest } from "@aws-sdk/protocol-http";
import { SignatureV4 } from "@aws-sdk/signature-v4";

import { AWS_REGION, INVENTORY_ENDPOINT } from "./config.js";

/** Thrown when the inventory service reports it cannot fulfil the reservation. */
export class InsufficientStockError extends Error {
  constructor(message = "insufficient stock") {
    super(message);
    this.name = "InsufficientStockError";
  }
}

/** Shape returned by the inventory reserve route. */
export interface ReserveResult {
  productId: string;
  available: number;
}

// SigV4 signer created once at module scope. The signing service is 'lambda'
// and credentials come from the standard provider chain (the Lambda execution
// role at runtime).
const signer = new SignatureV4({
  service: "lambda",
  region: AWS_REGION,
  sha256: Sha256,
  credentials: defaultProvider(),
});

/** Compute the hex-encoded SHA-256 of a UTF-8 string. */
async function hexSha256(payload: string): Promise<string> {
  const hash = new Sha256();
  hash.update(payload);
  const digest = await hash.digest();
  return Buffer.from(digest).toString("hex");
}

/**
 * Reserve `quantity` units of `productId` in the inventory service.
 *
 * Signs a POST to `${INVENTORY_ENDPOINT}/items/:productId/reserve` with SigV4 and
 * sends it with the global fetch.
 *
 * @param productId - product identifier to reserve.
 * @param quantity - positive number of units to reserve.
 * @returns the reserve result (productId + remaining available) from inventory.
 * @throws InsufficientStockError when inventory responds 409.
 * @throws Error when INVENTORY_ENDPOINT is unset or the response is not ok.
 */
export async function reserveStock(
  productId: string,
  quantity: number,
): Promise<ReserveResult> {
  if (!INVENTORY_ENDPOINT) {
    throw new Error("INVENTORY_ENDPOINT is not configured.");
  }

  const url = new URL(INVENTORY_ENDPOINT);
  const body = JSON.stringify({ quantity });
  const path = `${url.pathname.replace(/\/$/, "")}/items/${encodeURIComponent(productId)}/reserve`;

  const request = new HttpRequest({
    method: "POST",
    protocol: url.protocol,
    hostname: url.hostname,
    path,
    headers: {
      host: url.hostname,
      "content-type": "application/json",
      // Required: Lambda reads the payload hash from this header, not the body.
      "x-amz-content-sha256": await hexSha256(body),
    },
    body,
  });

  const signed = await signer.sign(request);

  const response = await fetch(`${url.origin}${path}`, {
    method: signed.method,
    headers: signed.headers,
    body,
  });

  if (response.status === 409) {
    throw new InsufficientStockError();
  }

  if (!response.ok) {
    throw new Error(`inventory reserve failed with status ${response.status}`);
  }

  return (await response.json()) as ReserveResult;
}
