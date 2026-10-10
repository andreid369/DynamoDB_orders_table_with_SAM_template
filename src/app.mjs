import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

// DDB_ENDPOINT is only set when testing against DynamoDB Local / LocalStack
const client = new DynamoDBClient({
  endpoint: process.env.DDB_ENDPOINT || undefined,
});
const ddb = DynamoDBDocumentClient.from(client);

const response = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const handler = async (event) => {
  let order;
  try {
    order = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
  } catch {
    return response(400, { message: "Invalid JSON body" });
  }

  if (!order?.orderId || !order?.itemId) {
    return response(400, { message: "orderId and itemId are required" });
  }

  try {
    await ddb.send(
      new PutCommand({
        TableName: process.env.TABLE_NAME,
        Item: { ...order, createdAt: new Date().toISOString() },
        // Don't overwrite an existing order item
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