import { randomBytes, createHash } from "node:crypto";

// Real authorization-code endpoints and login form, without emulating a browser/theme acceptance test.
export async function authorizationCodeLogin(
  runtime: { publicUrl: string; fetch: typeof globalThis.fetch },
  input: {
    tenantId: string;
    username: string;
    password: string;
    clientSecret: string;
  },
): Promise<{ access_token: string; refresh_token: string }> {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const redirect = `https://gw.${input.tenantId}.jgw.test/auth/callback`;
  const prefix = `${runtime.publicUrl}/realms/tenant-${input.tenantId}/protocol/openid-connect`;
  const cookies = new Map<string, string>();
  const remember = (response: Response) => {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      const index = pair.indexOf("=");
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  };
  const start = await runtime.fetch(
    `${prefix}/auth?${new URLSearchParams({ client_id: "j-groupware", response_type: "code", scope: "openid", redirect_uri: redirect, state, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") })}`,
    { redirect: "manual" },
  );
  remember(start);
  if (start.status !== 200)
    throw new Error(`OIDC login form failed (${start.status}).`);
  const html = await start.text();
  const form = html.match(/<form\b[^>]*id="kc-form-login"[^>]*>/)?.[0];
  const action = form?.match(/action="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
  if (!action || new URL(action).origin !== runtime.publicUrl)
    throw new Error("Missing same-origin Keycloak login action.");
  const login = await runtime.fetch(action, {
    method: "POST",
    redirect: "manual",
    headers: { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    body: new URLSearchParams({
      username: input.username,
      password: input.password,
      credentialId: "",
    }),
  });
  if (login.status !== 302)
    throw new Error(`OIDC credential form failed (${login.status}).`);
  const location = login.headers.get("location");
  if (!location) throw new Error("Missing OIDC callback.");
  const callback = new URL(location);
  if (
    callback.origin + callback.pathname !== redirect ||
    callback.searchParams.get("state") !== state
  )
    throw new Error("Unexpected OIDC callback.");
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("Missing authorization code.");
  const token = await runtime.fetch(`${prefix}/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "j-groupware",
      client_secret: input.clientSecret,
      redirect_uri: redirect,
      code,
      code_verifier: verifier,
    }),
  });
  if (token.status !== 200)
    throw new Error(`OIDC code exchange failed (${token.status}).`);
  return (await token.json()) as {
    access_token: string;
    refresh_token: string;
  };
}
