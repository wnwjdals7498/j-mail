import type { Pool } from "pg";
import { assertCustomerTenantId } from "@j-auth/contracts";
import { MAIL_ID_PATTERN } from "@j-mail/contracts";
import type { MailpitClient } from "./mailpit.js";

const marker = "X-JGW-Capture-ID";
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._+-]{0,127}$/;

export function captureIdFromHeaders(
  headers: Readonly<Record<string, readonly string[]>>,
): string | null {
  const values = Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === marker.toLowerCase())
    .flatMap(([, list]) => list);
  if (values.length !== 1) return null;
  const value = values[0]!.trim();
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value)
    ? value
    : null;
}

export class MailNotificationIngress {
  constructor(
    private readonly pool: Pool,
    private readonly tenant: string,
    private readonly mailpit: MailpitClient,
  ) {
    assertCustomerTenantId(tenant);
  }

  async receive(payload: unknown): Promise<boolean> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("Invalid webhook payload.");
    const id = (payload as Record<string, unknown>).ID;
    if (typeof id !== "string" || !new RegExp(MAIL_ID_PATTERN).test(id))
      throw new Error("Invalid webhook message id.");

    // The webhook summary has display fields only. Use the native read-only
    // headers API to recover the adapter's unforgeable-in-this-flow marker.
    const captureId = captureIdFromHeaders(
      await this.mailpit.messageHeaders(id),
    );
    if (!captureId) throw new Error("No trusted SMTP capture mapping.");

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const capture = (
        await client.query<{
          tenant_id: string;
          usernames: unknown;
          message_id: string | null;
        }>(
          "SELECT tenant_id,usernames,message_id FROM smtp_envelope_captures WHERE capture_id=$1 FOR UPDATE",
          [captureId],
        )
      ).rows[0];
      if (!capture || capture.tenant_id !== this.tenant)
        throw new Error("Capture tenant mismatch.");
      if (capture.message_id && capture.message_id !== id)
        throw new Error("Capture message id conflict.");
      if (
        !Array.isArray(capture.usernames) ||
        !capture.usernames.length ||
        capture.usernames.length > 100 ||
        capture.usernames.some(
          (name) => typeof name !== "string" || !USERNAME_PATTERN.test(name),
        ) ||
        new Set(capture.usernames).size !== capture.usernames.length
      )
        throw new Error("Invalid stored SMTP recipients.");

      await client.query(
        "UPDATE smtp_envelope_captures SET message_id=$2, linked_at=COALESCE(linked_at,clock_timestamp()) WHERE capture_id=$1 AND (message_id IS NULL OR message_id=$2)",
        [captureId, id],
      );
      await client.query(
        `INSERT INTO notification_outbox
           (tenant_id,mailpit_message_id,capture_id,usernames,event_type,created_at,available_at)
         VALUES ($1,$2,$3,$4::jsonb,'mail.new',clock_timestamp(),clock_timestamp())
         ON CONFLICT (tenant_id,mailpit_message_id) DO NOTHING`,
        [this.tenant, id, captureId, JSON.stringify(capture.usernames)],
      );
      const existing = (
        await client.query<{ capture_id: string; usernames: unknown }>(
          "SELECT capture_id,usernames FROM notification_outbox WHERE tenant_id=$1 AND mailpit_message_id=$2",
          [this.tenant, id],
        )
      ).rows[0];
      if (
        existing?.capture_id !== captureId ||
        JSON.stringify(existing.usernames) !== JSON.stringify(capture.usernames)
      )
        throw new Error("Mail notification dedup conflict.");
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

interface MailEvent {
  readonly id: string;
  readonly mailpit_message_id: string;
  readonly usernames: unknown;
  readonly lease_token: string;
  readonly attempts: number;
}

export function notificationEndpoint(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.port === "3001" ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Notifications require an explicit loopback origin.");
  return url.origin + "/internal/notifications";
}

export class MailNotificationSender {
  private readonly endpoint: string;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<boolean> | undefined;
  private stopped = false;
  private controller: AbortController | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly tenant: string,
    url: string,
    private readonly key: string,
    private readonly fetcher: typeof globalThis.fetch = globalThis.fetch,
  ) {
    assertCustomerTenantId(tenant);
    this.endpoint = notificationEndpoint(url);
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(key))
      throw new Error("Private notification key required.");
  }

  async tick(): Promise<boolean> {
    if (this.stopped) return false;
    const client = await this.pool.connect();
    let event: MailEvent | undefined;
    try {
      await client.query("BEGIN");
      event = (
        await client.query<MailEvent>(
          `WITH candidate AS (
             SELECT id FROM notification_outbox
             WHERE tenant_id=$1 AND delivered_at IS NULL
               AND available_at<=clock_timestamp()
               AND (locked_until IS NULL OR locked_until<=clock_timestamp())
             ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
           )
           UPDATE notification_outbox o
             SET attempts=o.attempts+1,lease_token=gen_random_uuid(),
                 locked_until=clock_timestamp()+interval '20 seconds'
           FROM candidate c
           WHERE o.tenant_id=$1 AND o.id=c.id
           RETURNING o.*`,
          [this.tenant],
        )
      ).rows[0];
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (!event) return false;

    const controller = new AbortController();
    this.controller = controller;
    try {
      if (
        typeof event.mailpit_message_id !== "string" ||
        !new RegExp(MAIL_ID_PATTERN).test(event.mailpit_message_id) ||
        !Array.isArray(event.usernames) ||
        !event.usernames.length ||
        event.usernames.length > 100 ||
        event.usernames.some(
          (name) => typeof name !== "string" || !USERNAME_PATTERN.test(name),
        )
      )
        throw new Error("Invalid stored mail notification.");
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        headers: {
          "Content-Type": "application/json",
          "X-JGW-Internal-Key": this.key,
        },
        body: JSON.stringify({
          tenant: this.tenant,
          service: "j-mail",
          type: "mail.new",
          usernames: event.usernames,
          title: "새 메일",
          body: "새 메일이 도착했습니다.",
          link: `/mail/messages/${event.mailpit_message_id}`,
          dedupKey: event.mailpit_message_id,
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Delivery failed.");
      }
      const length = Number(response.headers.get("content-length") ?? 0);
      if (
        length > 1024 ||
        !response.headers.get("content-type")?.startsWith("application/json")
      ) {
        await response.body?.cancel();
        throw new Error("Invalid notification receipt.");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Invalid notification receipt.");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 1024) throw new Error("Invalid notification receipt.");
          chunks.push(part.value);
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
      const receipt = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: unknown;
        duplicate?: unknown;
      };
      if (
        typeof receipt.id !== "string" ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(receipt.id) ||
        typeof receipt.duplicate !== "boolean"
      )
        throw new Error("Invalid notification receipt.");
      await this.pool.query(
        "UPDATE notification_outbox SET delivered_at=clock_timestamp(),locked_until=NULL,lease_token=NULL,last_error=NULL WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND delivered_at IS NULL",
        [this.tenant, event.id, event.lease_token],
      );
    } catch {
      await this.pool.query(
        "UPDATE notification_outbox SET available_at=clock_timestamp()+$4::int*interval '1 second',locked_until=NULL,lease_token=NULL,last_error='delivery_failed' WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND delivered_at IS NULL",
        [
          this.tenant,
          event.id,
          event.lease_token,
          Math.min(60, 2 ** Math.min(event.attempts, 6)),
        ],
      );
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
    return true;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    const run = () => {
      if (this.pending) return;
      this.pending = this.tick()
        .catch(() => false)
        .finally(() => {
          this.pending = undefined;
        });
    };
    this.timer = setInterval(run, 1000);
    this.timer.unref();
    run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.controller?.abort();
    await this.pending;
  }
}
