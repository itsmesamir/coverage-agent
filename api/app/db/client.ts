/**
 * Connection pool and query builder. The only place a connection string is read.
 *
 * postgres.js manages the pool; Drizzle is a thin typed layer over it with no
 * session or identity-map concept, so queries stay explicit and the ORM has
 * no implicit state that could leak into the pure packages.
 */

import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export function databaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");
  }
  return url;
}

/** A raw postgres.js connection. Callers are responsible for closing it. */
export function createClient(url: string = databaseUrl(), max = 10) {
  return postgres(url, { max, onnotice: () => {} });
}

export function createDb(client: ReturnType<typeof createClient>) {
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;

/** Process-wide handle for application code. Tests make their own. */
export const sqlClient = createClient();
export const db = createDb(sqlClient);
