import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, paginateScan } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const TABLE = process.env.ENTITIES_TABLE ?? "simple-bff-dev-entities";
const client = new DynamoDBClient({ region: process.env.AWS_REGION ?? "ap-southeast-1" });
const doc = DynamoDBDocumentClient.from(client);

const items = [];
for await (const page of paginateScan({ client: doc }, { TableName: TABLE })) {
  for (const raw of page.Items ?? []) items.push(unmarshall(raw));
}
console.log("item count:", items.length);
for (const it of items) console.log(JSON.stringify(it));
