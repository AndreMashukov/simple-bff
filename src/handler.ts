import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
  APIGatewayProxyEventV2WithRequestContext,
} from "aws-lambda";

type CognitoClaims = Record<string, string | undefined>;

type JwtAuthorizer = { jwt: { claims: CognitoClaims } };

type RequestContextWithAuthorizer =
  APIGatewayProxyEventV2WithRequestContext<
    APIGatewayProxyEventV2["requestContext"] & { authorizer?: JwtAuthorizer }
  >;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.ENTITIES_TABLE ?? "";

/**
 * GET /hello — protected by a Cognito User Pool JWT authorizer.
 * Returns a greeting plus the authenticated user's identity claims.
 */
export const hello: APIGatewayProxyHandlerV2 = async (event) => {
  const authEvent = event as RequestContextWithAuthorizer;
  const claims = authEvent.requestContext.authorizer?.jwt.claims;

  // /hello and /events share this handler. Route on rawPath.
  if (event.rawPath === "/events") {
    return handleEvents(authEvent);
  }

  const sub = claims?.sub ?? "unknown";
  const email = claims?.email ?? null;
  const username = claims?.["cognito:username"] ?? null;

  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      message: "Hello from a v4 Serverless BFF",
      stage: process.env.STAGE ?? "unknown",
      user: { sub, email, username },
      path: event.rawPath,
      method: event.requestContext.http.method,
    }),
  };
};

/**
 * GET /events — read the materialized view populated by the listener.
 *
 * Returns the 20 most recently-received events. Real BFFs would use a
 * Query with a KeyConditionExpression (e.g. pk begins_with "source#")
 * rather than a Scan, but for a small dev table Scan is fine and
 * simpler to reason about.
 */
async function handleEvents(
  authEvent: RequestContextWithAuthorizer,
): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}> {
  const claims = authEvent.requestContext.authorizer?.jwt.claims;
  const sub = claims?.sub ?? "unknown";

  log("info", "/events invoked", { sub, table: TABLE_NAME });

  const result = await ddb.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      Limit: 20,
    }),
  );

  const items = (result.Items ?? []).map((it) => ({
    pk: it.pk,
    sk: it.sk,
    source: it.source,
    detailType: it.detailType,
    time: it.time,
    receivedAt: it.receivedAt,
    eventId: it.eventId,
    detail: it.detail,
  }));

  // Sort newest first by sk (which is eventTime ISO).
  items.sort((a, b) => String(b.sk).localeCompare(String(a.sk)));

  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      table: TABLE_NAME,
      count: items.length,
      events: items,
    }),
  };
}

function log(
  level: "info" | "error",
  message: string,
  extra: Record<string, unknown>,
): void {
  const line = JSON.stringify({
    level,
    service: "simple-bff",
    fn: "hello",
    message,
    ...extra,
  });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}
