import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

// ---------------------------------------------------------------------------
// Initialisation: runs once per execution environment (cold start) and is
// reused by every later invocation of the same environment (warm start).
// Nothing in here is repeated per request.
// ---------------------------------------------------------------------------
const TABLE_NAME = process.env.TABLE_NAME;
// Only set when testing against DynamoDB Local / LocalStack
const DDB_ENDPOINT = process.env.DDB_ENDPOINT || undefined;

if (!TABLE_NAME) {
  // Fail the cold start loudly instead of failing every request later
  throw new Error("TABLE_NAME environment variable is not set");
}

// SDK v3 reuses HTTPS connections (keep-alive) by default, so the client
// created here also keeps its connection warm between invocations.
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ endpoint: DDB_ENDPOINT }),
  { marshallOptions: { removeUndefinedValues: true } }
);

const HEADERS = { "Content-Type": "application/json" };

const response = (statusCode, body) => ({
  statusCode,
  headers: HEADERS,
  body: JSON.stringify(body),
});

const isNonEmptyString = (value) =>
  typeof value === "string" && value.length > 0;

// ---------------------------------------------------------------------------
// Handler: only per-request work happens here.
// ---------------------------------------------------------------------------
export const handler = async (event) => {
  let order;
  try {
    order = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
  } catch {
    return response(400, { message: "Invalid JSON body" });
  }

  if (!isNonEmptyString(order?.orderId) || !isNonEmptyString(order?.itemId)) {
    return response(400, {
      message: "orderId and itemId are required and must be non-empty strings",
    });
  }

  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        // createdAt is set after the spread so a client cannot override it
        Item: { ...order, createdAt: new Date().toISOString() },
        // Do not overwrite an existing order item (same orderId + itemId)
        ConditionExpression: "attribute_not_exists(orderId)",
      })
    );
    return response(201, { orderId: order.orderId, itemId: order.itemId });
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return response(409, { message: "Order item already exists" });
    }
    console.error(err);
    return response(500, { message: "Could not save order" });
  }
};
