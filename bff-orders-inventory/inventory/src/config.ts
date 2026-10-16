/**
 * Centralized, typed runtime configuration read from environment variables.
 *
 * No secrets are hardcoded here: every deployment-specific value (region,
 * table name) comes from the environment, with safe local defaults.
 */

/** HTTP endpoint parsed into a host and a numeric port. */
export interface HttpEndpoint {
  host: string;
  port: number;
}

/** AWS region used for DynamoDB. Defaults to us-east-1. */
export const AWS_REGION: string = process.env.AWS_REGION ?? "us-east-1";

/**
 * DynamoDB table that stores inventory items. Each item has a `productId`
 * (string) partition key, a `productName` (string) attribute, and a numeric
 * `available` attribute. Defaults to "inventory".
 */
export const INVENTORY_TABLE: string =
  process.env.INVENTORY_TABLE ?? "inventory";

/** Default host used when no HTTP endpoint is configured. */
const DEFAULT_HOST = "127.0.0.1";

/** Default port used when no HTTP endpoint is configured. */
const DEFAULT_PORT = 3001;

/**
 * Parse the AWS_LAMBDA_HTTP_ENDPOINT environment variable into host and port.
 *
 * The value is expected in "host:port" form. When unset or malformed, the
 * function falls back to 127.0.0.1:3001 so the server can run locally.
 *
 * @returns the parsed host and numeric port.
 */
export function parseHttpEndpoint(): HttpEndpoint {
  const raw = process.env.AWS_LAMBDA_HTTP_ENDPOINT;
  if (!raw) {
    return { host: DEFAULT_HOST, port: DEFAULT_PORT };
  }

  const [host, portText] = raw.split(":");
  const port = Number(portText);

  if (!host || !Number.isFinite(port)) {
    return { host: DEFAULT_HOST, port: DEFAULT_PORT };
  }

  return { host, port };
}
