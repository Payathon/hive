import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.ts";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function connectPostgres(url: string): Promise<Db> {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const db = drizzle(url, { schema });
  await migrate(db, { migrationsFolder });
  return db as unknown as Db;
}

// In-process Postgres for tests and quick local runs without Docker.
export async function connectPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const db = drizzle(new PGlite(dataDir), { schema });
  await migrate(db, { migrationsFolder });
  return db as unknown as Db;
}

// Tests: a fresh in-process PGlite, or with TEST_DATABASE_URL a fresh database on that Postgres
// server (one per call, never dropped; point it at a throwaway server).
export async function connectTestDb(): Promise<Db> {
  const admin = process.env.TEST_DATABASE_URL;
  if (!admin) return connectPglite();
  const pg = (await import("pg")).default;
  const name = `hive_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  await client.query(`CREATE DATABASE ${name}`);
  await client.end();
  const url = new URL(admin);
  url.pathname = `/${name}`;
  return connectPostgres(url.href);
}
