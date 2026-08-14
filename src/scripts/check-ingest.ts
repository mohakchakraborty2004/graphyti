import { HydraDBClient } from "@hydradb/sdk";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  console.log("database:", process.env.HYDRA_DB_DATABASE, "collection:", process.env.HYDRA_DB_COLLECTION);
  const client = new HydraDBClient({ token: process.env.HYDRA_DB_API_KEY });
  const database = process.env.HYDRA_DB_DATABASE!;

 const list = await client.context.list({ database, collection: process.env.HYDRA_DB_COLLECTION, type: "knowledge", page: 1, pageSize: 100 });
console.log("total ingested:", list.data); // <- fix field name per grep result

  const rel = await client.context.relations({ database,collection: process.env.HYDRA_DB_COLLECTION, id: "model:Post", type: "knowledge" });
  console.log("model:post relations:", JSON.stringify(rel.data, null, 2));

  const result = await client.query({
    database,
    collection: process.env.HYDRA_DB_COLLECTION,
    query: "What fields does the Post model have?",
    type: "knowledge",
    queryBy: "hybrid",
    mode: "thinking",
    graphContext: true,
  });
  console.log("query chunks:", result.data);
}

main().catch(console.error);