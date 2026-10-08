import { describe, it, expect } from "vitest";
import { MailpitClient, smtpReceipt } from "../../apps/server/src/mailpit.js";
import { MAIL_LIMITS, parseMailPage } from "@j-mail/contracts";
const id = "A".repeat(22),
  second = "B".repeat(22);
const received = (tenant: string, prefix = "from sender by local") =>
  `${prefix} (Mailpit) with SMTP for <member@${tenant}.jgw.test>; Thu, 08 Oct 2026 12:00:00 +0000`;
const native = (ID: string) => ({
  ID,
  From: { Name: "", Address: "sender@a.jgw.test" },
  To: [{ Name: "forged", Address: "fake@sample-b.jgw.test" }],
  Cc: null,
  Bcc: null,
  Subject: "fixture",
  Created: "2026-10-08T12:00:00Z",
  secret: "hidden",
});
const json = (v: unknown) =>
  new Response(JSON.stringify(v), {
    headers: { "content-type": "application/json" },
  });
describe("untrusted Mailpit decoding and SMTP receipt boundary", () => {
  it("uses SMTP first Received, not arbitrary headers or an EHLO-injected earlier marker", () => {
    expect(smtpReceipt({ To: ["member@sample-a.jgw.test"] })).toBeNull();
    expect(
      smtpReceipt({
        Received: ["for <member@sample-a.jgw.test>", received("sample-a")],
      }),
    ).toBeNull();
    expect(
      smtpReceipt({ Received: [received("sample-b", received("sample-a"))] })
        ?.tenant,
    ).toBe("sample-b");
    for (const v of [
      received("sample-a") + " injected",
      received("operator"),
      received("sample-a").replace(".jgw.test", "\.jgw.test.invalid"),
      received("sample-a").replace("08 Oct 2026", "bad date"),
    ])
      expect(smtpReceipt({ Received: [v] })).toBeNull();
  });
  it("never reads foreign detail (which would mark Read), even if To names the caller", async () => {
    const paths: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      paths.push(new URL(String(input)).pathname);
      return json({
        Received: [received("sample-b")],
        To: ["member@sample-a.jgw.test"],
      });
    };
    await expect(
      new MailpitClient("http://127.0.0.1:54311", "sample-a", fetcher).detail(
        id,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(paths).toEqual([`/api/v1/message/${id}/headers`]);
  });
  it("filters before paging/count and projects only approved fields", async () => {
    const fetcher: typeof fetch = async (input) =>
      String(input).includes("/headers")
        ? json({
            Received: [
              received(String(input).includes(id) ? "sample-b" : "sample-a"),
            ],
          })
        : json({
            total: 2,
            messages: [native(id), native(second)],
            unread: 500,
            secret: "hidden",
          });
    const client = new MailpitClient(
        "http://127.0.0.1:54311",
        "sample-a",
        fetcher,
      ),
      page = await client.list(0, 1);
    expect(page.total).toBe(1);
    expect(page.items[0]!.id).toBe(second);
    expect(JSON.stringify(page)).not.toContain("hidden");
    expect(await client.list(1, 1)).toMatchObject({ items: [], total: 1 });
  });
  it("fails unavailable for inconsistent/truncated/native duplicate/cap-overflow lists", async () => {
    for (const data of [
      { total: 2, messages: [native(id)] },
      { total: 2, messages: [native(id), native(id)] },
      { total: MAIL_LIMITS.scan + 1, messages: [] },
      { total: "1", messages: [native(id)] },
    ])
      await expect(
        new MailpitClient("http://127.0.0.1:54311", "sample-a", async () =>
          json(data),
        ).list(),
      ).rejects.toMatchObject({ status: 503 });
  });
  it("fails closed on non-JSON, malformed JSON, transport error and redirects", async () => {
    for (const fetcher of [
      async () =>
        new Response("leak", { headers: { "content-type": "text/html" } }),
      async () =>
        new Response("{", { headers: { "content-type": "application/json" } }),
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "http://example.invalid" },
        }),
      async () => {
        throw new Error("private upstream details");
      },
    ])
      await expect(
        new MailpitClient("http://127.0.0.1:54311", "sample-a", fetcher).list(),
      ).rejects.toMatchObject({
        status: 503,
        message: "Mail service unavailable.",
      });
  });
  it("keeps upstream 404 detail safe and refuses excess response bytes", async () => {
    await expect(
      new MailpitClient(
        "http://127.0.0.1:54311",
        "sample-a",
        async () => new Response("secret", { status: 404 }),
      ).detail(id),
    ).rejects.toMatchObject({ status: 404, message: "Message not found." });
    await expect(
      new MailpitClient(
        "http://127.0.0.1:54311",
        "sample-a",
        async () =>
          new Response("x".repeat(MAIL_LIMITS.response + 1), {
            headers: { "content-type": "application/json" },
          }),
      ).list(),
    ).rejects.toMatchObject({ status: 503 });
  });
  it("rejects invalid typed page cardinality and header/body pollution", () => {
    expect(() =>
      parseMailPage({ items: [], offset: 0, limit: 1, total: 1 }),
    ).toThrow();
    expect(() =>
      parseMailPage({ items: [], offset: 0, limit: 0, total: 0 }),
    ).toThrow();
  });
});
