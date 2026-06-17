import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const client = new DynamoDBClient({ region: "ap-southeast-1" });
const result = await client.send(
  new ScanCommand({ TableName: "simple-bff-dev-entities" }),
);
const items = (result.Items ?? []).map((i) => unmarshall(i));
console.log("item count:", items.length);
for (const it of items) {
  console.log(JSON.stringify(it));
}
