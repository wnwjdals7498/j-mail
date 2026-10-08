import { assertCustomerTenantId } from "@j-auth/contracts";
import {
  MAIL_LIMITS,
  MAIL_ID_PATTERN,
  parseMailHeaders,
  parseMailSummary,
  parseMailDetail,
} from "@j-mail/contracts";
import type { MailPage, MailDetail } from "@j-mail/contracts";
import { mailpitOrigin } from "./config.js";
import { unavailable, missing } from "./errors.js";
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw unavailable();
  return value as Record<string, unknown>;
}
function nativeAddress(value: unknown) {
  const r = object(value);
  return { name: r.Name, address: r.Address };
}
function nativeAddresses(value: unknown) {
  if (value === null) return [];
  if (!Array.isArray(value) || value.length > MAIL_LIMITS.addresses)
    throw unavailable();
  return value.map(nativeAddress);
}
// SMTP-only capture, pinned Mailpit, one-tenant production profile required.
// The last marker prevents EHLO text from spoofing an earlier "for <...>".
export function smtpReceipt(
  headers: Readonly<Record<string, readonly string[]>>,
) {
  const first = Object.entries(headers).find(
    ([k]) => k.toLowerCase() === "received",
  )?.[1][0];
  if (!first) return null;
  const marker = " (Mailpit) with SMTP for <",
    p = first.lastIndexOf(marker);
  if (p < 0) return null;
  const match =
    /^([^@\s<>]+)@([a-z0-9][a-z0-9-]{0,62})\.jgw\.test>; (.+)$/i.exec(
      first.slice(p + marker.length),
    );
  if (
    !match ||
    match[1]!.length > MAIL_LIMITS.address ||
    !Number.isFinite(Date.parse(match[3]!))
  )
    return null;
  try {
    assertCustomerTenantId(match[2]!.toLowerCase());
  } catch {
    return null;
  }
  return {
    tenant: match[2]!.toLowerCase(),
    receivedAt: new Date(match[3]!).toISOString(),
  };
}
export class MailpitClient {
  private readonly origin: string;
  constructor(
    origin: string,
    private readonly tenant: string,
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {
    this.origin = mailpitOrigin(origin);
    assertCustomerTenantId(tenant);
  }
  private async read(
    path: string,
    signal: AbortSignal,
    allowMissing = false,
  ): Promise<unknown> {
    let response: Response | undefined;
    try {
      response = await this.fetcher(this.origin + path, {
        method: "GET",
        redirect: "error",
        signal,
      });
      if (response.status === 404 && allowMissing) {
        await response.body?.cancel();
        throw missing();
      }
      if (
        response.status !== 200 ||
        !response.headers.get("content-type")?.startsWith("application/json")
      )
        throw unavailable();
      const reader = response.body?.getReader();
      if (!reader) throw unavailable();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAIL_LIMITS.response) throw unavailable();
          chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
      } catch (e) {
        await reader.cancel().catch(() => undefined);
        throw e;
      } finally {
        reader.releaseLock();
      }
    } catch (e) {
      await response?.body?.cancel().catch(() => undefined);
      if (e instanceof Error && "status" in e && e.status === 404) throw e;
      throw unavailable();
    }
  }
  private project(row: Record<string, unknown>, receivedAt: string) {
    return parseMailSummary({
      id: row.ID,
      from: nativeAddress(row.From),
      to: nativeAddresses(row.To),
      cc: nativeAddresses(row.Cc),
      bcc: nativeAddresses(row.Bcc),
      subject: row.Subject,
      receivedAt,
    });
  }
  private async headers(id: string, signal: AbortSignal) {
    return parseMailHeaders(
      await this.read(`/api/v1/message/${id}/headers`, signal, true),
    );
  }
  async list(offset = 0, limit = 20): Promise<MailPage> {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > MAIL_LIMITS.scan ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAIL_LIMITS.page
    )
      throw new Error("Invalid mail page.");
    try {
      const signal = AbortSignal.timeout(5000),
        result = object(
          await this.read(
            `/api/v1/messages?start=0&limit=${MAIL_LIMITS.scan + 1}`,
            signal,
          ),
        );
      if (
        !Number.isInteger(result.total) ||
        Number(result.total) < 0 ||
        Number(result.total) > MAIL_LIMITS.scan ||
        !Array.isArray(result.messages) ||
        result.messages.length !== result.total
      )
        throw unavailable();
      const rows = result.messages.map(object),
        allowed: boolean[] = Array(rows.length).fill(false) as boolean[];
      const seen = new Set<string>();
      for (const row of rows) {
        if (
          typeof row.ID !== "string" ||
          !new RegExp(MAIL_ID_PATTERN).test(row.ID) ||
          seen.has(row.ID)
        )
          throw unavailable();
        seen.add(row.ID);
      }
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(8, rows.length) }, async () => {
          for (;;) {
            const i = next++,
              row = rows[i];
            if (!row) return;
            const receipt = smtpReceipt(
              await this.headers(String(row.ID), signal),
            );
            allowed[i] = receipt?.tenant === this.tenant;
          }
        }),
      );
      const visible = rows.filter((_r, i) => allowed[i]);
      return {
        items: visible.slice(offset, offset + limit).map((row) => {
          if (
            typeof row.Created !== "string" ||
            !Number.isFinite(Date.parse(row.Created))
          )
            throw unavailable();
          return this.project(row, new Date(row.Created).toISOString());
        }),
        total: visible.length,
        offset,
        limit,
      };
    } catch {
      throw unavailable();
    }
  }
  async detail(id: string): Promise<MailDetail> {
    if (!new RegExp(MAIL_ID_PATTERN).test(id)) throw missing();
    try {
      const signal = AbortSignal.timeout(5000),
        headers = await this.headers(id, signal),
        receipt = smtpReceipt(headers);
      if (receipt?.tenant !== this.tenant) throw missing();
      // GET detail marks native Read. Do not issue it before readonly ownership check.
      const row = object(
        await this.read(`/api/v1/message/${id}`, signal, true),
      );
      if (row.ID !== id) throw unavailable();
      return parseMailDetail({
        ...this.project(row, receipt.receivedAt),
        headers,
        text: row.Text,
        html: row.HTML,
      });
    } catch (e) {
      if (e instanceof Error && "status" in e && e.status === 404) throw e;
      throw unavailable();
    }
  }
}
