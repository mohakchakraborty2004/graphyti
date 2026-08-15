import { HydraDBClient } from "@hydradb/sdk";
import { requireHydraConfig } from "../config";

async function main() {
  // Previously this script read process.env directly without ever loading .env,
  // so it only worked when the vars were exported in the shell.
  const { apiKey, database } = requireHydraConfig();
  const client = new HydraDBClient({ token: apiKey });

  await client.databases.create({
    database,
    databaseMetadataSchema: [
      { name: "node_kind", dataType: "VARCHAR", enableMatch: true, maxLength: 64 },
      { name: "file_path", dataType: "VARCHAR", enableMatch: true, maxLength: 512 },
    ],
  });

  while (true) {
    const status = await client.databases.status({ database });

    if (!status.data || !status.data.infra) {
      throw new Error("databases.status() returned no data despite not throwing");
    }

    if (status.data.infra.readyForIngestion) break;
    await new Promise(r => setTimeout(r, 5000));
  }

  console.log("database ready");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});