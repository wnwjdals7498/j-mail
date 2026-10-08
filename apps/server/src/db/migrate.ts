import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { Pool } from "pg";

const migrationDirectory = new URL(
  "../../../../deploy/migrations/",
  import.meta.url,
);

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    const identity = await client.query<{
      current_user: string;
      database: string;
      rolsuper: boolean;
    }>(
      "SELECT current_user, current_database() AS database, rolsuper FROM pg_roles WHERE rolname = current_user",
    );
    const actor = identity.rows[0];
    if (
      actor?.current_user !== "jgw_mail" ||
      actor.database !== "jgw_mail" ||
      actor.rolsuper
    ) {
      throw new Error(
        "Migrations require the non-superuser jgw_mail role in the jgw_mail database.",
      );
    }
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path = public");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('j-mail-migrations'))",
    );
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query("REVOKE ALL ON schema_migrations FROM PUBLIC");
    const names = (await readdir(migrationDirectory))
      .filter((name) => /^\d{3}-[a-z0-9-]+\.sql$/.test(name))
      .sort();
    if (names.length === 0) throw new Error("No migration files found.");
    for (const name of names) {
      const sql = await readFile(new URL(name, migrationDirectory), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const applied = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE name = $1",
        [name],
      );
      if (applied.rows[0]) {
        if (applied.rows[0].checksum !== checksum)
          throw new Error("An applied migration was modified.");
        continue;
      }
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
        [name, checksum],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
