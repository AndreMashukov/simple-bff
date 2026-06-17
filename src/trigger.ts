import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type {
  DynamoDBRecord,
  DynamoDBStreamHandler,
} from "aws-lambda";

// One EventBridge client per warm Lambda container. AWS_REGION is set
// by the Lambda runtime automatically; no explicit region config needed.
const eb = new EventBridgeClient({});

// All events emitted by this trigger share a stable Source prefix
// "<service>.<entity>" so downstream subscribers can write rules like
// `source: ["simple-bff.entity"]`. DetailType distinguishes the kind
// of change: entity.created / entity.modified / entity.deleted.
const SOURCE = "simple-bff.entity";
const TABLE_NAME = process.env.ENTITIES_TABLE ?? "";
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME ?? "";

/**
 * Trigger leg of the Trilateral API.
 *
 * Wired to a DynamoDB stream on the EntitiesTable (NEW_AND_OLD_IMAGES).
 * Consumes CDC records and re-publishes each row change as a domain
 * event onto the local EventBridge bus. Other BFFs / services in the
 * same domain subscribe with `source: ["simple-bff.entity"]` and react
 * to entity.created / entity.modified / entity.deleted without ever
 * knowing the row shape.
 *
 * Batch failure reporting (functionResponseType:
 * ReportBatchItemFailures) means a single failed PutEvents does not
 * poison the whole shard. PutEvents accepts up to 10 entries per call,
 * so we chunk larger stream batches.
 */
export const handle: DynamoDBStreamHandler = async (event) => {
  log("info", "trigger invoked", {
    bus: EVENT_BUS_NAME,
    table: TABLE_NAME,
    recordCount: event.Records.length,
  });

  const entries = event.Records.map(buildEntry).filter(<T>(x: T | null): x is T => x !== null);

  if (entries.length === 0) {
    log("info", "trigger done (no entries)", { succeeded: 0, failed: 0 });
    return { batchItemFailures: [] };
  }

  // PutEvents hard limit: 10 entries per call. Chunk accordingly.
  const CHUNK = 10;
  const failures: { itemIdentifier: string }[] = [];

  for (let i = 0; i < entries.length; i += CHUNK) {
    const slice = entries.slice(i, i + CHUNK);
    // Map slice indices back to the original record's eventID for
    // partial-failure reporting. We rely on entries.length ===
    // event.Records.length here (filter only drops nulls, which we
    // never produce -- see buildEntry).
    const recordSlice = event.Records.slice(i, i + CHUNK);
    try {
      const result = await eb.send(
        new PutEventsCommand({
          Entries: slice,
        }),
      );

      const failedCount = result.FailedEntryCount ?? 0;
      if (failedCount > 0) {
        // PutEvents does not tell us WHICH entries failed when there
        // are partial failures -- it returns the full list and a count.
        // Conservative: report the whole chunk as failed so the next
        // invocation retries. Idempotency is provided downstream by
        // the listener's pk/sk design (Put is idempotent on the same
        // item) and the bus's at-least-once semantics.
        for (const r of recordSlice) {
          failures.push({ itemIdentifier: r.eventID ?? r.dynamodb?.SequenceNumber ?? "unknown" });
        }
        log("error", "trigger PutEvents partial failure", {
          failedCount,
          chunkSize: slice.length,
          firstError: result.Entries?.[0]?.ErrorMessage,
          firstCode: result.Entries?.[0]?.ErrorCode,
        });
      } else {
        log("info", "trigger chunk ok", { chunkSize: slice.length });
      }
    } catch (err) {
      log("error", "trigger PutEvents threw", {
        error: err instanceof Error ? err.message : String(err),
        chunkSize: slice.length,
      });
      for (const r of recordSlice) {
        failures.push({ itemIdentifier: r.eventID ?? r.dynamodb?.SequenceNumber ?? "unknown" });
      }
    }
  }

  log("info", "trigger done", {
    succeeded: event.Records.length - failures.length,
    failed: failures.length,
  });

  return { batchItemFailures: failures };
};

/**
 * Build a single EventBridge PutEvents entry from a DynamoDB stream
 * record. Returns null for events we don't care about (defensive --
 * the filterPatterns in serverless.yml already drop anything other
 * than INSERT/MODIFY/REMOVE, so this is belt-and-braces).
 */
function buildEntry(rec: DynamoDBRecord): {
  Source: string;
  DetailType: string;
  Detail: string;
  EventBusName: string;
} | null {
  const eventName = rec.eventName;
  if (!eventName) return null;

  // NEW_AND_OLD_IMAGES gives us both. For REMOVE only OldImage is set;
  // for INSERT only NewImage; for MODIFY both.
  //
  // Type seam: aws-lambda's AttributeValue (in @types/aws-lambda) and
  // @aws-sdk/util-dynamodb's AttributeValue (in @aws-sdk/client-dynamodb)
  // are structurally identical at runtime but nominally distinct in
  // the type system -- the SDK's union has a $unknown discriminator
  // that aws-lambda's doesn't. Cast through `any` at the boundary;
  // the wire format is identical.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const newRaw = rec.dynamodb?.NewImage as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oldRaw = rec.dynamodb?.OldImage as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const keysRaw = rec.dynamodb?.Keys as any;
  const newImage = newRaw ? unmarshall(newRaw) : undefined;
  const oldImage = oldRaw ? unmarshall(oldRaw) : undefined;

  const detailType =
    eventName === "INSERT"
      ? "entity.created"
      : eventName === "MODIFY"
        ? "entity.modified"
        : eventName === "REMOVE"
          ? "entity.deleted"
          : null;

  if (!detailType) return null;

  const detail = {
    eventName,
    pk: newImage?.pk ?? oldImage?.pk,
    sk: newImage?.sk ?? oldImage?.sk,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    keys: keysRaw ? unmarshall(keysRaw) : undefined,
    newImage,
    oldImage,
    // ApproximateCreationDateTime is millis since epoch; convert for
    // consumers that prefer ISO. Falls back to "now" if absent.
    approximateCreationDateTime: rec.dynamodb?.ApproximateCreationDateTime
      ? new Date(rec.dynamodb.ApproximateCreationDateTime * 1000).toISOString()
      : new Date().toISOString(),
    sequenceNumber: rec.dynamodb?.SequenceNumber,
  };

  return {
    Source: SOURCE,
    DetailType: detailType,
    Detail: JSON.stringify(detail),
    // Explicit EventBusName keeps this off the default bus even if a
    // future maintainer attaches a resource policy that allows it.
    EventBusName: EVENT_BUS_NAME,
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
    fn: "trigger",
    message,
    ...extra,
  });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}
