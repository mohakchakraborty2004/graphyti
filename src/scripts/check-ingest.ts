import { HydraDBClient } from "@hydradb/sdk";
import { configSummary, requireHydraConfig } from "../config";

async function main() {
  console.log(configSummary());
  const { apiKey, database, collection } = requireHydraConfig();
  const client = new HydraDBClient({ token: apiKey });

  const list = await client.context.list({ database, collection, type: "knowledge", page: 1, pageSize: 100 });
  console.log("total ingested:", list.data); // <- fix field name per grep result

  const rel = await client.context.relations({ database, collection, id: "model:Post", type: "knowledge" });
  console.log("model:post relations:", JSON.stringify(rel.data, null, 2));

  const result = await client.query({
    database,
    collection,
    query: "What fields does the Post model have?",
    type: "knowledge",
    queryBy: "hybrid",
    mode: "thinking",
    graphContext: true,
  });
  console.log("query chunks:", result.data);
}

main().catch(console.error);
