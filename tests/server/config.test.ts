import { describe, it, expect } from "vitest";
import {
  externalFile,
  loadDatabaseConfig,
  mailpitOrigin,
  port,
} from "../../apps/server/src/config.js";
describe("mail external config and fixed source boundary", () => {
  it("accepts only an explicit loopback HTTP source and reserved ports cannot enter any source", () => {
    expect(mailpitOrigin("http://127.0.0.1:54311/")).toBe(
      "http://127.0.0.1:54311",
    );
    for (const u of [
      "http://localhost:54311",
      "http://169.254.169.254:80",
      "http://remote.invalid:54311",
      "http://127.0.0.1:3001",
      "http://u:p@127.0.0.1:54311",
      "http://127.0.0.1:54311/api",
      "http://127.0.0.1:54311/?tenant=b",
      "https://127.0.0.1:54311",
    ])
      expect(() => mailpitOrigin(u)).toThrow();
    for (const raw of ["3001", "0", "65536", "01", "-1"])
      expect(() => port(raw)).toThrow();
  });
  it("keeps dedicated DB identity, rejects placeholders and prevents checkout secrets", () => {
    const d = loadDatabaseConfig({ JML_DB_PASSWORD: "fixture" });
    expect(d).toMatchObject({
      database: "jgw_mail",
      user: "jgw_mail",
      statement_timeout: 5000,
    });
    for (const env of [
      { JML_DB_PASSWORD: "__PLACEHOLDER_FOO" },
      { JML_DB_PASSWORD: "fixture", JML_DB_USER: "postgres" },
      { JML_DB_PASSWORD: "fixture", JML_DB_NAME: "jgw_other" },
    ])
      expect(() => loadDatabaseConfig(env)).toThrow();
    expect(() => externalFile("/workspace/j-mail/private.pem")).toThrow();
    expect(() => externalFile("relative.pem")).toThrow();
  });
});
