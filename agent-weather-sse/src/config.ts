/**
 * Centralized, typed runtime configuration read from environment variables.
 *
 * No secrets are hardcoded here: every deployment-specific value (region,
 * model id, S3 bucket) comes from the environment, with safe local defaults.
 */

/** HTTP endpoint parsed into a host and a numeric port. */
export interface HttpEndpoint {
  host: string;
  port: number;
}

/** AWS region used for Bedrock and S3. Defaults to us-east-1. */
export const AWS_REGION: string = process.env.AWS_REGION ?? "us-east-1";

/**
 * Stable agent id. Used by the SessionManager to scope this agent's snapshots
 * (e.g. scopes/agent/weather/ instead of the default scopes/agent/agent/).
 */
export const AGENT_ID = "weather";

/**
 * Bedrock model id used by the agent. Defaults to Amazon Nova 2 Lite, a
 * recent, low-cost reasoning model. The Strands harness defaults to Claude,
 * so this must be passed explicitly.
 */
export const BEDROCK_MODEL_ID: string =
  process.env.BEDROCK_MODEL_ID ?? "us.amazon.nova-2-lite-v1:0";

/**
 * S3 bucket used to persist agent sessions. Optional at import time and only
 * required when the agent is actually built (see later features).
 */
export const SESSION_BUCKET: string | undefined = process.env.SESSION_BUCKET;

/** Key prefix for session objects stored in {@link SESSION_BUCKET}. */
export const SESSION_PREFIX: string =
  process.env.SESSION_PREFIX ?? "weather-agent/";

/**
 * Local directory used to persist sessions when {@link SESSION_BUCKET} is not
 * set. This is a LOCAL-DEVELOPMENT fallback only: the Lambda Web Functions
 * filesystem is ephemeral, so S3 (SESSION_BUCKET) must be used in the cloud.
 */
export const SESSION_DIR: string =
  process.env.SESSION_DIR ?? "./.sessions/";

/** Default host used when no HTTP endpoint is configured. */
const DEFAULT_HOST = "127.0.0.1";

/** Default port used when no HTTP endpoint is configured. */
const DEFAULT_PORT = 3000;

/**
 * Parse the AWS_LAMBDA_HTTP_ENDPOINT environment variable into host and port.
 *
 * The value is expected in "host:port" form. When unset or malformed, the
 * function falls back to 127.0.0.1:3000 so the server can run locally.
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
