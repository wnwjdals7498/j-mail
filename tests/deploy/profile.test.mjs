import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowedRecipients,
  mailpitEnvironment,
  MAILPIT_IMAGE,
} from "../../deploy/mailpit-profile.mjs";
test("single customer capture profile declares no forwarding/relay/checking or ignore-rejection flags", () => {
  const e = mailpitEnvironment("customer-a", {
    database: "/data/mailpit.db",
    smtp: "127.0.0.1:54312",
    http: "127.0.0.1:54311",
  });
  assert.equal(e.MP_SMTP_IGNORE_REJECTED_RECIPIENTS, "false");
  assert.equal(e.MP_DISABLE_VERSION_CHECK, "true");
  assert.ok(
    !Object.keys(e).some((k) =>
      /RELAY|FORWARD|WEBHOOK|SPAMASSASSIN|POP3/.test(k),
    ),
  );
  assert.ok(MAILPIT_IMAGE.includes("v1.31.4@sha256:"));
  const regex = new RegExp(e.MP_SMTP_ALLOWED_RECIPIENTS.slice(4), "i");
  assert.ok(regex.test("member@customer-a.jgw.test"));
  assert.ok(!regex.test("member@customer-b.jgw.test"));
});
test("tenant regex construction rejects duplicates/injection/empty and anchors escaped domains", () => {
  for (const ts of [
    [],
    ["customer-a", "customer-a"],
    ["customer.*"],
    ["operator"],
  ])
    assert.throws(() => allowedRecipients(ts));
  const re = new RegExp(
    allowedRecipients(["customer-a", "customer-b"]).slice(4),
    "i",
  );
  assert.ok(re.test("member@customer-b.jgw.test"));
  for (const bad of [
    "member@customerXajgwXtest",
    "member@customer-a.jgw.test.invalid",
    "member@example.invalid",
  ])
    assert.ok(!re.test(bad));
});
test("production capture profile refuses external binds, port conflicts and reserved ports", () => {
  for (const smtp of [
    "0.0.0.0:54312",
    "remote.invalid:54312",
    "127.0.0.1:3001",
    "127.0.0.1:54311",
  ])
    assert.throws(() =>
      mailpitEnvironment("customer-a", {
        database: "/data/mailpit.db",
        smtp,
        http: "127.0.0.1:54311",
      }),
    );
});
