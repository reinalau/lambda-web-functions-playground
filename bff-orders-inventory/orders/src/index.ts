/**
 * Deployed entrypoint and full Express HTTP surface for the orders BFF service.
 *
 * This single file holds the main code: it builds the Express app (a GET
 * /health probe, POST /orders that reserves stock in the inventory service via
 * a SigV4-signed call and then persists the order to DynamoDB, and GET
 * /orders/:id lookup) and, when run directly, starts the HTTP server on the
 * host:port Lambda provides via AWS_LAMBDA_HTTP_ENDPOINT.
 *
 * Compiles to dist/index.js, which is the file the Lambda Web Function runs.
 *
 * No /ping route is defined: that path is reserved by the Lambda Web Functions
 * platform and never reaches the application.
 */
import { randomUUID } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

import { ORDERS_TABLE, parseHttpEndpoint } from "./config.js";
import { ddb } from "./db.js";
import { InsufficientStockError, reserveStock } from "./inventory-client.js";

/** Request body expected by POST /orders. */
interface CreateOrderBody {
  productId?: unknown;
  quantity?: unknown;
  customer?: unknown;
}

/** True when value is a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** True when value is a finite positive number. */
function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Build the Express application. Stateless by design: no mutable per-request
 * state is kept in module scope; order state lives in DynamoDB, keyed by id.
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

  app.post("/orders", async (req: Request, res: Response) => {
    const { productId, quantity, customer } = req.body as CreateOrderBody;

    if (!isNonEmptyString(productId) || !isPositiveNumber(quantity) || !isNonEmptyString(customer)) {
      res.status(400).json({
        error:
          "productId and customer must be non-empty strings and quantity a positive number.",
      });
      return;
    }

    try {
      // Reserve stock downstream first; only persist the order if it succeeds.
      const reserve = await reserveStock(productId, quantity);

      const order = {
        id: randomUUID(),
        productId,
        quantity,
        customer,
        available: reserve.available,
        createdAt: new Date().toISOString(),
      };

      await ddb.send(new PutCommand({ TableName: ORDERS_TABLE, Item: order }));

      res.status(201).json(order);
    } catch (cause) {
      if (cause instanceof InsufficientStockError) {
        res.status(409).json({ error: "insufficient stock" });
        return;
      }

      console.error("create order failed:", cause);
      res.status(500).json({ error: "internal error" });
    }
  });

  app.get("/orders/:id", async (req: Request, res: Response) => {
    const { id } = req.params;

    try {
      const result = await ddb.send(
        new GetCommand({ TableName: ORDERS_TABLE, Key: { id } }),
      );

      if (!result.Item) {
        res.status(404).json({ error: "not found" });
        return;
      }

      res.status(200).json(result.Item);
    } catch (cause) {
      console.error("get order failed:", cause);
      res.status(500).json({ error: "internal error" });
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
