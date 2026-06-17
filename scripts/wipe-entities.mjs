// Wipe all rows from simple-bff-dev-entities. Used between smoke
// tests so loop-induced rows from a prior run don't pollute the
// next observation. Pagination is handled by scanning until LastEvaluatedKey
// is undefined, and DeleteItem is used per row (table has no GSI or
// cascade; one item at a time is fine for a dev wipe).
import {
  DynamoDBClient,
  ScanCommand,
  DeleteItemCommand,
} from "@aws-sdk/client-dynamodb";

const TABLE = "simple-bff-dev-entities";
const REGION = "ap-southeast-1";

const ddb = new DynamoDBClient({ region: REGION });

let scanned = 0;
let deleted = 0;
let lastKey;

do {
  const out = await ddb.send(
    new ScanCommand({
      TableName: TABLE,
      ProjectionExpression: "pk, sk",
      ExclusiveStartKey: lastKey,
    }),
  );
  scanned += out.Count ?? 0;

  for (const item of out.Items ?? []) {
    await ddb.send(
      new DeleteItemCommand({
        TableName: TABLE,
        Key: { pk: item.pk, sk: item.sk },
      }),
    );
    deleted += 1;
  }

  lastKey = out.LastEvaluatedKey;
} while (lastKey);

console.log(JSON.stringify({ scanned, deleted, table: TABLE }));
