/**
 * Agent wiring: composes the Strands harness into a weather/trip-planning
 * assistant backed by Amazon Nova and S3-persisted sessions.
 */
import { createHarness } from "@strands-agents/harness";
import { SessionManager } from "@strands-agents/sdk";
import { S3Storage, LocalFileStorage } from "@strands-agents/sdk/storage";
import type { Agent } from "@strands-agents/sdk";

import * as config from "./config.js";
import { geocodeTool } from "./tools/geocode.js";
import { getForecastTool } from "./tools/get-forecast.js";

/**
 * Domain prompt appended after the harness contract. It constrains the agent
 * to the weather domain and enforces the geocode -> get_forecast tool order.
 */
const INSTRUCTIONS = [
  "You are a weather and trip-planning assistant.",
  "Help users understand upcoming weather and plan trips around it.",
  "To answer any question about a place, first call the geocode tool to turn",
  "the city name into coordinates, then call get_forecast with those",
  "coordinates. Never guess coordinates. If geocode reports the city was not",
  "found, ask the user to clarify the location. Summarize forecasts in plain,",
  "concise language and call out rain or extreme temperatures when relevant.",
].join(" ");

/**
 * Build a weather agent bound to a single conversation.
 *
 * The factory is async because the harness imports model providers on demand.
 *
 * @param conversationId - Stable id used as the session key, so a
 *   conversation's state is restored across stateless Lambda invocations.
 * @returns A configured Strands {@link Agent}.
 */
export async function createWeatherAgent(
  conversationId: string,
): Promise<Agent> {
  // Sessions use the SDK passthrough (SessionManager + a Storage backend), not
  // the harness `session` option, because that option is filesystem-only.
  //
  // Backend selection:
  // - SESSION_BUCKET set   -> S3Storage (the correct choice on Lambda Web
  //   Functions, whose filesystem is ephemeral).
  // - SESSION_BUCKET unset -> LocalFileStorage, a LOCAL-DEVELOPMENT fallback
  //   that writes sessions to SESSION_DIR so the agent runs without S3.
  const storage = config.SESSION_BUCKET
    ? new S3Storage(config.SESSION_BUCKET, { prefix: config.SESSION_PREFIX })
    : new LocalFileStorage(config.SESSION_DIR);
  // Pass the unified Storage directly: the SessionManager wraps it with its
  // SnapshotStorageAdapter internally (the recommended form).
  const sessionManager = new SessionManager({
    sessionId: conversationId,
    storage,
  });

  return createHarness({
    // Stable agent id, so session snapshots are scoped under this name.
    id: config.AGENT_ID,
    // Model is passed explicitly: the harness default is Claude, we need Nova.
    model: config.BEDROCK_MODEL_ID,
    // Disable every built-in tool (shell, read, write, edit, web_fetch,
    // web_search, programmatic_tool_caller, subagent). Least privilege for a
    // public weather agent; it only needs the two domain tools below.
    builtinTools: [],
    tools: [geocodeTool, getForecastTool],
    sessionManager,
    instructions: INSTRUCTIONS,
  });
}
