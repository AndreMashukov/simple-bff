// Smoke test for the trigger leg of the Trilateral API.
//
// Writes a single DynamoDB row to simple-bff-dev-entities. The
// trigger Lambda is wired to the table's stream and should:
//   1. Fire once with recordCount: 1
//   2. Publish one entity.created event to simple-bff-dev-events
//   3. NOT cause the listener to write a row back (the listener's
//      rule is configured with anything-but: simple-bff.entity)
//
// Run from /opt/data/serverless/simple-bff.
import { randomUUID } from "node:crypto";
import {
  DynamoDBClient,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";

const TABLE = "simple-bff-dev-entities";
const REGION = "ap-southeast-1";

const ddb = new DynamoDBClient({ region: REGION });

const pk = `smoke#${randomUUID()}`;
const sk = "v0";

const before = Date.now();
const out = await ddb.send(
  new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: pk },
      sk: { S: sk },
      data: { S: "hello trigger" },
    },
  }),
);
const after = Date.now();

console.log(
  JSON.stringify(
    {
      put: "ok",
      httpStatus: out.$metadata.httpStatusCode,
      pk,
      sk,
      latencyMs: after - before,
      putTimeUtc: new Date(after).toISOString(),
    },
    null,
    2,
  ),
);
