import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";

// One DocumentClient per warm Lambda container. AWS_REGION is set
// automatically by the Lambda runtime, so we don't need to configure
// the region explicitly.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env.ENTITIES_TABLE ?? "";

/**
 * Listener leg of the Trilateral API.
 *
 * Wired to an SQS queue that is fed by an EventBridge rule on the custom
 * bus named in EVENT_BUS_NAME. Receives one or more records per invocation
 * (SQS batches) and projects each event into the local materialized view
 * (the EntitiesTable DynamoDB table).
 *
 * Single-table design (per the book, page 55-56):
 *   pk  = <source>#<entityId>   groups by event source
 *   sk  = <eventTime ISO>       sorts within a source
 *   discriminator = <source>    supports GSI queries later
 *   detailType, detail, receivedAt, source, time as attributes
 *
 * Batch failure reporting (functionResponseType: ReportBatchItemFailures)
 * means a single bad record does not poison the whole batch.
 */
export const handle = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const eventBus = process.env.EVENT_BUS_NAME ?? "<unknown>";
  const queueUrl = process.env.LISTENER_QUEUE_URL ?? "<unknown>";

  log("info", "listener invoked", {
    bus: eventBus,
    queue: queueUrl,
    table: TABLE_NAME,
    recordCount: event.Records.length,
  });

  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (err) {
      log("error", "listener record failed", {
        messageId: record.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  log("info", "listener done", {
    succeeded: event.Records.length - batchItemFailures.length,
    failed: batchItemFailures.length,
  });

  return { batchItemFailures };
};

async function processRecord(record: SQSRecord): Promise<void> {
  // EventBridge -> SQS delivers a body that looks like:
  //   { "version": "0", "id": "...", "detail-type": "...",
  //     "source": "...", "account": "...", "time": "...",
  //     "region": "...", "resources": [...], "detail": { ... } }
  // Our rule sets InputPath: "$" (the whole envelope), so record.body
  // is the full EventBridge event. We accept both shapes defensively:
  // if body has a `source` and `detail` it's the envelope; otherwise
  // it's already the unwrapped detail.
  const body = JSON.parse(record.body) as Record<string, unknown>;

  const source = (body.source as string) ?? "<unknown-source>";
  const detailType =
    (body["detail-type"] as string) ?? "<unknown-detail-type>";
  const time = (body.time as string) ?? new Date().toISOString();
  const detail = (body.detail as Record<string, unknown>) ?? body;
  const eventId = (body.id as string) ?? record.messageId;
  const entityId =
    (detail.id as string) ||
    (detail.entityId as string) ||
    (detail["detail-id"] as string) ||
    eventId;

  // sk includes eventId so two events for the same (source, entity) at
  // the same ISO timestamp do not collide. The (pk, sk) tuple is what
  // makes the projection unique; if the same upstream event is
  // delivered twice (SQS at-least-once), the conditional Put below
  // turns the second write into a no-op rather than an overwrite.
  const item = {
    pk: `${source}#${entityId}`,
    sk: `${time}#${eventId}`,
    discriminator: source,
    source,
    detailType,
    time,
    detail,
    receivedAt: new Date().toISOString(),
    eventId,
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
        // Idempotency: only write if (pk, sk) is new. Duplicate
        // deliveries (same upstream event re-driven by SQS) become a
        // no-op instead of an overwrite that would later emit a
        // spurious MODIFY on the stream.
        ConditionExpression:
          "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      }),
    );

    log("info", "event projected", {
      messageId: record.messageId,
      pk: item.pk,
      sk: item.sk,
      source,
      detailType,
    });
  } catch (err) {
    if (
      err instanceof Error &&
      err.name === "ConditionalCheckFailedException"
    ) {
      log("info", "event already projected", {
        messageId: record.messageId,
        pk: item.pk,
        sk: item.sk,
      });
      return;
    }
    throw err;
  }
}

function log(
  level: "info" | "error",
  message: string,
  extra: Record<string, unknown>,
): void {
  // One JSON object per line, parseable by CloudWatch Logs Insights.
  // console.log goes to CloudWatch stdout in Lambda.
  const line = JSON.stringify({
    level,
    service: "simple-bff",
    fn: "listener",
    message,
    ...extra,
  });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}
