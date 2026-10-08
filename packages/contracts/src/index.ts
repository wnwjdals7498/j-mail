export const MAIL_SERVICE = "j-mail" as const;
export const MAIL_PATHS = {
  messages: "/mail/messages",
  message: (id: string) => "/mail/messages/" + encodeURIComponent(id),
} as const;
export const MAIL_LIMITS = {
  page: 100,
  scan: 1000,
  addresses: 100,
  address: 320,
  name: 1000,
  subject: 1000,
  body: 4194304,
  headers: 65536,
  response: 16777216,
} as const;
export const MAIL_ID_PATTERN = "^[A-Za-z0-9]{22}$";
export interface MailAddress {
  readonly name: string;
  readonly address: string;
}
export interface MailSummary {
  readonly id: string;
  readonly from: MailAddress;
  /** Display headers; these do not authorize SMTP delivery or notification targets. */
  readonly to: readonly MailAddress[];
  readonly cc: readonly MailAddress[];
  readonly bcc: readonly MailAddress[];
  readonly subject: string;
  readonly receivedAt: string;
}
export interface MailPage {
  readonly items: readonly MailSummary[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}
export interface MailDetail extends MailSummary {
  readonly headers: Readonly<Record<string, readonly string[]>>;
  readonly text: string;
  /** Untrusted HTML. A browser renderer must use a restrictive sandbox. */
  readonly html: string;
}
export interface MailError {
  readonly code:
    | "invalid_input"
    | "unauthenticated"
    | "forbidden"
    | "not_found"
    | "unavailable";
  readonly message: string;
  readonly requestId: string;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid mail response.");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max)
    throw new Error("Invalid mail text.");
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max)
    throw new Error("Invalid mail number.");
  return Number(value);
}
function address(value: unknown): MailAddress {
  const r = record(value);
  return {
    name: text(r.name, MAIL_LIMITS.name),
    address: text(r.address, MAIL_LIMITS.address),
  };
}
function addresses(value: unknown): readonly MailAddress[] {
  if (!Array.isArray(value) || value.length > MAIL_LIMITS.addresses)
    throw new Error("Invalid mail addresses.");
  return value.map(address);
}
export function parseMailHeaders(
  value: unknown,
): Readonly<Record<string, readonly string[]>> {
  const r = record(value),
    out: Record<string, readonly string[]> = Object.create(null) as Record<
      string,
      readonly string[]
    >;
  const keys = Object.keys(r);
  if (
    keys.length > 100 ||
    new TextEncoder().encode(JSON.stringify(r)).byteLength > MAIL_LIMITS.headers
  )
    throw new Error("Invalid mail headers.");
  for (const key of keys) {
    const values = r[key];
    if (
      !/^[A-Za-z0-9-]{1,100}$/.test(key) ||
      !Array.isArray(values) ||
      values.length > 100
    )
      throw new Error("Invalid mail header.");
    out[key] = values.map((v) => text(v, MAIL_LIMITS.headers));
  }
  return out;
}
export function parseMailSummary(value: unknown): MailSummary {
  const r = record(value),
    id = text(r.id, 22),
    receivedAt = text(r.receivedAt, 24);
  if (
    !new RegExp(MAIL_ID_PATTERN).test(id) ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(receivedAt) ||
    !Number.isFinite(Date.parse(receivedAt))
  )
    throw new Error("Invalid mail identity/time.");
  return {
    id,
    from: address(r.from),
    to: addresses(r.to),
    cc: addresses(r.cc),
    bcc: addresses(r.bcc),
    subject: text(r.subject, MAIL_LIMITS.subject),
    receivedAt,
  };
}
export function parseMailPage(value: unknown): MailPage {
  const r = record(value),
    limit = integer(r.limit, 1, MAIL_LIMITS.page),
    offset = integer(r.offset, 0, MAIL_LIMITS.scan),
    total = integer(r.total, 0, MAIL_LIMITS.scan);
  if (
    !Array.isArray(r.items) ||
    r.items.length !== Math.min(limit, Math.max(0, total - offset))
  )
    throw new Error("Invalid mail page.");
  const items = r.items.map(parseMailSummary);
  if (new Set(items.map((m) => m.id)).size !== items.length)
    throw new Error("Duplicate mail identity.");
  return { items, total, offset, limit };
}
export function parseMailDetail(value: unknown): MailDetail {
  const r = record(value);
  return {
    ...parseMailSummary(r),
    headers: parseMailHeaders(r.headers),
    text: text(r.text, MAIL_LIMITS.body),
    html: text(r.html, MAIL_LIMITS.body),
  };
}
