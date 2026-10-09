import { describe, expect, it } from "vitest";
import {
  captureIdFromHeaders,
  MailNotificationIngress,
  MailNotificationSender,
} from "../../apps/server/src/mail-notifications.js";
import { rewriteMailpitMarker } from "../../apps/server/src/mail-capture.js";

const captureId = "12345678-1234-1234-1234-123456789abc";
const messageId = "AbCdEf0123456789GhIjKl";

describe("trusted SMTP recipient capture and mail notification", () => {
  it("removes client marker spoofing and installs one adapter marker", () => {
    const input = Buffer.from(
      "From: a@example.invalid\r\nX-JGW-Capture-ID: forged\r\n folded\r\nSubject: test\r\n\r\nbody\r\n",
    );
    const output = rewriteMailpitMarker(input, captureId).toString();
    expect(output.match(/X-JGW-Capture-ID:/gi)).toHaveLength(1);
    expect(output).toContain(`X-JGW-Capture-ID: ${captureId}`);
    expect(output).not.toContain("forged");
    expect(output).toContain("Subject: test\r\n");
  });

  it("rejects absent, duplicate, malformed, or folded capture markers", () => {
    expect(captureIdFromHeaders({})).toBeNull();
    expect(
      captureIdFromHeaders({ "X-JGW-Capture-ID": [captureId, captureId] }),
    ).toBeNull();
    expect(
      captureIdFromHeaders({ "X-JGW-Capture-ID": [captureId + "x"] }),
    ).toBeNull();
    expect(captureIdFromHeaders({ "x-jgw-capture-id": [captureId] })).toBe(
      captureId,
    );
  });

  it("links webhook Mailpit ID to all stored SMTP usernames and idempotently inserts one outbox event", async () => {
    const queries: { sql: string; values?: unknown[] }[] = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        queries.push({ sql: String(sql), ...(values ? { values } : {}) });
        if (String(sql).startsWith("SELECT tenant_id,usernames,message_id"))
          return {
            rows: [
              {
                tenant_id: "sample-a",
                usernames: ["first", "second"],
                message_id: null,
              },
            ],
          };
        if (String(sql).startsWith("SELECT capture_id,usernames"))
          return {
            rows: [{ capture_id: captureId, usernames: ["first", "second"] }],
          };
        return { rows: [] };
      },
      release: () => undefined,
    };
    const pool = {
      connect: async () => client,
    } as never;
    const mailpit = {
      messageHeaders: async (id: string) => {
        expect(id).toBe(messageId);
        return { "X-JGW-Capture-ID": [captureId] };
      },
    } as never;
    const ingress = new MailNotificationIngress(pool, "sample-a", mailpit);
    expect(
      await ingress.receive({
        ID: messageId,
        To: ["not-an-authority@example.invalid"],
      }),
    ).toBe(true);
    expect(
      queries.filter((q) => q.sql.includes("INSERT INTO notification_outbox")),
    ).toHaveLength(1);
    expect(
      queries.find((q) => q.sql.includes("UPDATE smtp_envelope_captures"))
        ?.values,
    ).toEqual([captureId, messageId]);
    expect(queries.some((q) => q.sql === "COMMIT")).toBe(true);
  });

  it("fails closed when the Mailpit ID has no exact capture marker", async () => {
    const pool = {
      connect: async () => {
        throw new Error("must not touch PG");
      },
    } as never;
    const mailpit = {
      messageHeaders: async () => ({ "X-JGW-Capture-ID": ["forged"] }),
    } as never;
    await expect(
      new MailNotificationIngress(pool, "sample-a", mailpit).receive({
        ID: messageId,
      }),
    ).rejects.toThrow("No trusted SMTP capture mapping.");
  });

  it("sends the complete username set with a Mailpit-ID dedup key and a safe local link", async () => {
    const sent: unknown[] = [];
    const row = {
      id: "00000000-0000-4000-8000-000000000001",
      mailpit_message_id: messageId,
      usernames: ["first", "second"],
      lease_token: "00000000-0000-4000-8000-000000000002",
      attempts: 1,
    };
    const client = {
      query: async (sql: string) => {
        if (String(sql).includes("RETURNING o.*")) return { rows: [row] };
        return { rows: [] };
      },
      release: () => undefined,
    };
    const pool = {
      connect: async () => client,
      query: async () => ({ rows: [] }),
    } as never;
    const fetcher: typeof fetch = async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          id: "00000000-0000-4000-8000-000000000003",
          duplicate: false,
        }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    };
    const sender = new MailNotificationSender(
      pool,
      "sample-a",
      "http://127.0.0.1:54312",
      "abcdefghijklmnopqrstuvwxyz123456",
      fetcher,
    );
    expect(await sender.tick()).toBe(true);
    expect(sent).toEqual([
      {
        tenant: "sample-a",
        service: "j-mail",
        type: "mail.new",
        usernames: ["first", "second"],
        title: "새 메일",
        body: "새 메일이 도착했습니다.",
        link: `/mail/messages/${messageId}`,
        dedupKey: messageId,
      },
    ]);
  });
});
