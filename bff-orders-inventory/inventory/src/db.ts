/**
 * DynamoDB document client shared across the whole process.
 *
 * The low-level DynamoDBClient is constructed ONCE at module scope and wrapped
 * with the DynamoDBDocumentClient. Creating the client a single time and
 * reusing it (so the underlying HTTP connection pool with keep-alive is kept
 * warm across invocations) is encouraged per Lambda Web Functions best
 * practices: a Web Function stays warm between requests, so a per-request
 * client would waste connection setup on every call.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { AWS_REGION } from "./config.js";

const client = new DynamoDBClient({ region: AWS_REGION });

/** Shared DynamoDB document client. Tests stub its `send` method. */
export const ddb = DynamoDBDocumentClient.from(client);
