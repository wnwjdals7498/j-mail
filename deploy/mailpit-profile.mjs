import { assertCustomerTenantId } from "@j-auth/contracts";
// A customer VM owns exactly one tenant's Mailpit instance (architecture S1/S2).
export const MAILPIT_IMAGE =
  "axllent/mailpit:v1.31.4@sha256:b68349e3a014b90c5610bfb26b2ae36f3892d7b8cf25ee140c6c71c98d2fcf48";
export function allowedRecipients(tenants) {
  if (
    !Array.isArray(tenants) ||
    !tenants.length ||
    tenants.length > 100 ||
    new Set(tenants).size !== tenants.length
  )
    throw new Error("Invalid allowed tenants.");
  for (const tenant of tenants) assertCustomerTenantId(tenant);
  const domains = tenants.map((t) => t + "\\.jgw\\.test").join("|");
  return "(?i)^[^@\\s<>]+@(" + domains + ")$";
}
export function mailpitEnvironment(tenant, paths) {
  assertCustomerTenantId(tenant);
  for (const value of [paths.smtp, paths.http]) {
    const match = /^127\.0\.0\.1:([1-9][0-9]*)$/.exec(value);
    if (!match || Number(match[1]) > 65535 || Number(match[1]) === 3001)
      throw new Error("Mailpit binds must be explicit loopback ports.");
  }
  if (
    paths.smtp === paths.http ||
    typeof paths.database !== "string" ||
    !/^\/[A-Za-z0-9_./-]+$/.test(paths.database) ||
    paths.database.includes("/../") ||
    paths.database.includes("/./")
  )
    throw new Error("Invalid capture paths.");
  const env = {
    MP_DATABASE: paths.database,
    MP_SMTP_BIND_ADDR: paths.smtp,
    MP_UI_BIND_ADDR: paths.http,
    MP_SMTP_ALLOWED_RECIPIENTS: allowedRecipients([tenant]),
    MP_SMTP_IGNORE_REJECTED_RECIPIENTS: "false",
    MP_DISABLE_VERSION_CHECK: "true",
    MP_SMTP_DISABLE_RDNS: "true",
    MP_QUIET: "true",
    MP_USE_MESSAGE_DATES: "false",
    MP_MAX_MESSAGE_SIZE: "4",
    MP_MAX_MESSAGES: "0",
    MP_ALLOWED_HOSTS: "127.0.0.1,localhost",
  };
  // Only these known flags exist. No relay/forwarding, webhook, POP3 or remote checker.
  return Object.freeze(env);
}
