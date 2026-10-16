/**
 * Deployed entrypoint and full Express HTTP surface for the inventory service.
 *
 * This single file holds the main code: it builds the Express app (a GET
 * /health probe, GET /items/:productId lookup, and POST /items/:productId/reserve that
 * decrements stock with a DynamoDB conditional update) and, when run directly,
 * starts the HTTP server on the host:port Lambda provides via
 * AWS_LAMBDA_HTTP_ENDPOINT.
 *
 * Compiles to dist/index.js, which is the file the Lambda Web Function runs.
 *
 * No /ping route is defined: that path is reserved by the Lambda Web Functions
 * platform and never reaches the application.
 */
import express, { type Express, type Request, type Response } from "express";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { INVENTORY_TABLE, parseHttpEndpoint } from "./config.js";
import { ddb } from "./db.js";

/** Request body expected by POST /items/:productId/reserve. */
interface ReserveRequestBody {
  quantity?: unknown;
}

/**
 * Build the Express application. Stateless by design: no mutable per-request
 * state is kept in module scope; item state lives in DynamoDB, keyed by productId.
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

  app.get("/items/:productId", async (req: Request, res: Response) => {
    const { productId } = req.params;

    try {
      const result = await ddb.send(
        new GetCommand({ TableName: INVENTORY_TABLE, Key: { productId } }),
      );

      if (!result.Item) {
        res.status(404).json({ error: "not found" });
        return;
      }

      res.status(200).json({
        productId,
        productName: result.Item.productName,
        available: result.Item.available,
      });
    } catch (cause) {
      console.error("get item failed:", cause);
      res.status(500).json({ error: "internal error" });
    }
  });

  app.post("/items/:productId/reserve", async (req: Request, res: Response) => {
    const { productId } = req.params;
    const { quantity } = req.body as ReserveRequestBody;

    if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0) {
      res.status(400).json({ error: "quantity must be a positive number." });
      return;
    }

    try {
      // Conditional decrement: only succeeds when the item exists and has at
      // least `quantity` available, so stock can never go negative.
      const result = await ddb.send(
        new UpdateCommand({
          TableName: INVENTORY_TABLE,
          Key: { productId },
          UpdateExpression: "SET available = available - :qty",
          ConditionExpression: "attribute_exists(productId) AND available >= :qty",
          ExpressionAttributeValues: { ":qty": quantity },
          ReturnValues: "UPDATED_NEW",
        }),
      );

      res.status(200).json({ productId, available: result.Attributes?.available });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "ConditionalCheckFailedException") {
        res.status(409).json({ error: "insufficient stock" });
        return;
      }

      console.error("reserve failed:", cause);
      res.status(500).json({ error: "internal error" });
    }
  });

  return app;
}

/**
 * Start the HTTP server, binding to the host:port from AWS_LAMBDA_HTTP_ENDPOINT
 * (falling back to 127.0.0.1:3001 for local development).
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
