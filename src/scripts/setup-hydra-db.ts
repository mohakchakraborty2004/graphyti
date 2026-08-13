import { HydraDBClient } from "@hydradb/sdk";

async function main() {
  const client = new HydraDBClient({ token: process.env.HYDRA_DB_API_KEY });

  await client.databases.create({
    database: process.env.HYDRA_DB_DATABASE!,
    databaseMetadataSchema: [
      { name: "node_kind", dataType: "VARCHAR", enableMatch: true, maxLength: 64 },
      { name: "file_path", dataType: "VARCHAR", enableMatch: true, maxLength: 512 },
    ],
  });

  while (true) {
    const status = await client.databases.status({ database: process.env.HYDRA_DB_DATABASE! });

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