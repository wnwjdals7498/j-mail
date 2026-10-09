import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Pool } from "pg";
import { createCapture } from "./capture.js";
import { loadDatabaseConfig } from "../../apps/server/src/config.js";
import { migrate } from "../../apps/server/src/db/migrate.js";
import { readFile, stat } from "node:fs/promises";

describe("actual mail capture/SMTP policy and dedicated PostgreSQL foundation", () => {
  let pool: Pool, capture: Awaited<ReturnType<typeof createCapture>>;
  const tenant = "mail-foundation";
  beforeAll(async () => {
    if (process.env.JML_TEST_RUNTIME !== "isolated-cloud")
      throw new Error("Isolated mail tests required.");
    pool = new Pool(loadDatabaseConfig());
    await migrate(pool);
    capture = await createCapture(tenant);
  });
  afterAll(async () => {
    await capture?.close();
    await pool?.end();
  });
  it("accepts actual internal SMTP recipients and rejects external, unregistered and suffix domains", async () => {
    expect(
      await capture.send(
        [`member@${tenant}.jgw.test`, `second@${tenant}.jgw.test`],
        `From: sender@${tenant}.jgw.test\r\nTo: member@${tenant}.jgw.test\r\nSubject: internal-capture`,
      ),
    ).toEqual([250, 250]);
    for (const bad of [
      "fixture@example.invalid",
      "other@unregistered.jgw.test",
      `member@${tenant}.jgw.test.invalid`,
      `member@sub.${tenant}.jgw.test`,
    ])
      expect(
        (await capture.send([bad], "Subject: must-not-store"))[0],
      ).toBeGreaterThanOrEqual(500);
    const result = (await capture.api("/api/v1/messages")) as { total: number };
    expect(result.total).toBe(1);
  });
  it("preserves the Mailpit volume and message identity over actual restart", async () => {
    const first = (await capture.api("/api/v1/messages")) as {
      messages: { ID: string }[];
    };
    await capture.restart();
    const second = (await capture.api("/api/v1/messages")) as typeof first;
    expect(second.messages.map((m) => m.ID)).toEqual(
      first.messages.map((m) => m.ID),
    );
    expect((await stat(capture.root + "/mailpit.db")).size).toBeGreaterThan(0);
  });
  it("measures why To/Cc/Bcc cannot authorize tenant delivery, including SMTP-added first Received", async () => {
    await capture.send(
      [`actual@${tenant}.jgw.test`, `bcc@${tenant}.jgw.test`],
      `From: sender@${tenant}.jgw.test\r\nTo: forged@another-tenant.jgw.test\r\nSubject: envelope-proof`,
    );
    const list = (await capture.api("/api/v1/messages")) as {
      messages: {
        ID: string;
        Subject: string;
        To: { Address: string }[];
        Bcc: { Address: string }[];
      }[];
    };
    const message = list.messages.find((m) => m.Subject === "envelope-proof")!;
    expect(message.To[0]!.Address).toBe("forged@another-tenant.jgw.test");
    expect(message.Bcc.map((a) => a.Address)).toContain(
      `actual@${tenant}.jgw.test`,
    );
    const headers = (await capture.api(
      "/api/v1/message/" + message.ID + "/headers",
    )) as { Received: string[] };
    expect(headers.Received[0]).toContain(
      `with SMTP for <actual@${tenant}.jgw.test>`,
    );
  });
  it("has no container network or relay and bridges only owned Unix sockets to loopback", () => {
    const configuration = capture.configuration();
    expect(configuration.NetworkMode).toBe("none");
    expect(configuration.ReadonlyRootfs).toBe(true);
    expect(configuration.CapDrop).toContain("ALL");
    expect(new URL(capture.origin).hostname).toBe("127.0.0.1");
  });
  it("runs immutable SQL migrations idempotently as the dedicated non-superuser", async () => {
    await migrate(pool);
    const result = await pool.query(
      "SELECT current_user,current_database(),rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user",
    );
    expect(result.rows[0]).toMatchObject({
      current_user: "jgw_mail",
      current_database: "jgw_mail",
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
    const ledger = await pool.query(
      "SELECT name,checksum FROM schema_migrations",
    );
    expect(ledger.rows.map((row) => row.name).sort()).toEqual([
      "001-mail-foundation.sql",
      "002-mail-notifications.sql",
    ]);
    expect(
      ledger.rows.every((row) => /^[a-f0-9]{64}$/.test(row.checksum)),
    ).toBe(true);
    expect(
      await readFile(
        new URL(
          "../../deploy/migrations/001-mail-foundation.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    ).toContain("Original messages belong to the Mailpit volume");
  });
  it("denies cross-service/system DB connect and role creation rather than merely checking config", async () => {
    for (const database of ["postgres", "template1", "jgw_other"]) {
      const other = new Pool({
        ...loadDatabaseConfig(),
        database,
        connectionTimeoutMillis: 1000,
      });
      try {
        await expect(other.query("SELECT 1")).rejects.toThrow();
      } finally {
        await other.end();
      }
    }
    await expect(
      pool.query("CREATE ROLE must_not_be_created"),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
