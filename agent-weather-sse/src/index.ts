/**
 * Deployed entrypoint and full Express HTTP surface for the weather agent.
 *
 * This single file holds the main code: it builds the Express app (streaming
 * POST /chat over Server-Sent Events, plus a GET /health probe) and, when run
 * directly, starts the HTTP server on the host:port Lambda provides via
 * AWS_LAMBDA_HTTP_ENDPOINT.
 *
 * Compiles to dist/index.js, which is the file the Lambda Web Function runs
 * (set AWS_LAMBDA_NODEJS_ENTRYPOINT=dist/index.js when the default index.js
 * assumption does not apply).
 *
 * No /ping route is defined: that path is reserved by the Lambda Web Functions
 * platform and never reaches the application.
 */
import express, { type Express, type Request, type Response } from "express";

import { createWeatherAgent } from "./agent.js";
import { parseHttpEndpoint } from "./config.js";

/** Request body expected by POST /chat. */
interface ChatRequestBody {
  conversationId?: unknown;
  message?: unknown;
}

/**
 * Write a single SSE frame. Each frame is a `field: value` line followed by a
 * blank line that terminates the event.
 */
function writeSseData(res: Response, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Build the Express application. Stateless by design: no mutable per-request
 * state is kept in module scope; per-conversation state lives in S3, keyed by
 * conversationId.
 *
 * Exported so tests can exercise the routes without binding a port.
 *
 * @returns A configured Express app ready to be bound to a host and port.
 */
export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "healthy" });
  });

  app.post("/chat", async (req: Request, res: Response) => {
    const { conversationId, message } = req.body as ChatRequestBody;

    if (typeof conversationId !== "string" || typeof message !== "string") {
      res
        .status(400)
        .json({ error: "conversationId and message are required strings." });
      return;
    }

    // Open the SSE stream before producing tokens.
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    try {
      const agent = await createWeatherAgent(conversationId);

      for await (const event of agent.stream(message)) {
        if (
          event.type === "modelStreamUpdateEvent" &&
          event.event.type === "modelContentBlockDeltaEvent" &&
          event.event.delta.type === "textDelta"
        ) {
          writeSseData(res, { token: event.event.delta.text });
        }
      }

      // Terminal event so the client knows the stream completed cleanly.
      res.write("event: done\ndata: {}\n\n");
      res.end();
    } catch (cause) {
      // Log the full error (including the underlying cause) so S3/Bedrock
      // failures are visible in CloudWatch, not only sent to the client.
      console.error("chat request failed:", cause);
      if (cause instanceof Error && cause.cause) {
        console.error("caused by:", cause.cause);
      }
      const detail = cause instanceof Error ? cause.message : String(cause);
      res.write(`event: error\ndata: ${JSON.stringify({ error: detail })}\n\n`);
      res.end();
    }
  });

  return app;
}

/**
 * Start the HTTP server, binding to the host:port from AWS_LAMBDA_HTTP_ENDPOINT
 * (falling back to 127.0.0.1:3000 for local development).
 */
function startServer(): void {
  const { host, port } = parseHttpEndpoint();
  const app = createApp();

  app.listen(port, host, () => {
    console.log(`Server listening on ${host}:${port}`);
  });
}

// Start the server on import, both locally (`node dist/index.js`) and on Lambda
// Web Functions, where the platform imports this module through a generated
// wrapper rather than running it as the main entry file. Tests set
// NODE_ENV=test to import `createApp()` without binding a port.
if (process.env.NODE_ENV !== "test") {
  startServer();
}
