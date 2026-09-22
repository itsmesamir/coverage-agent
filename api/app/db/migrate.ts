/**
 * Apply pending migrations.
 *
 * Drizzle-kit generates SQL but does not know about Postgres extensions, so
 * `CREATE EXTENSION IF NOT EXISTS vector` is prepended to the initial
 * migration by hand -- see the note at the top of that file. It has to run
 * before any vector column is created, and it belongs in a versioned migration
 * rather than typed into psql once.
 */

import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createClient, createDb, databaseUrl } from "./client.js";

async function main(): Promise<void> {
  const url = databaseUrl();
  // A single connection: migrations are serial and must not race each other.
  const client = createClient(url, 1);
  try {
    await migrate(createDb(client), { migrationsFolder: "api/app/db/migrations" });
    const redacted = url.replace(/\/\/[^@]*@/, "//***@");
    console.log(`migrations applied  ${redacted}`);
  } finally {
    await client.end();
  }
}

await main();
