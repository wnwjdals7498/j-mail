import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const repository = fileURLToPath(new URL("../", import.meta.url));
try {
  const env = await realpath(
    process.env.JML_TEST_ENV ??
      path.resolve(repository, "../.suite-runtime/j-mail/integration.env"),
  );
  const auth = await realpath(
    process.env.JAUTH_TEST_ENV ??
      path.resolve(repository, "../.suite-runtime/j-auth/integration.env"),
  );
  if (
    ![env, auth].every((f) =>
      path.relative(repository, f).startsWith(".." + path.sep),
    )
  )
    throw new Error();
  const child = spawn(
    process.execPath,
    [
      `--env-file=${auth}`,
      `--env-file=${env}`,
      path.join(repository, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      "vitest.integration.config.ts",
      ...process.argv.slice(2),
    ],
    {
      cwd: repository,
      env: { ...process.env, JML_TEST_ENV: env, JAUTH_TEST_ENV: auth },
      shell: false,
      stdio: "inherit",
    },
  );
  child.once("error", () => {
    process.stderr.write("Could not start actual mail tests.\n");
    process.exitCode = 1;
  });
  child.once("close", (code) => {
    process.exitCode = code ?? 1;
  });
} catch {
  process.stderr.write(
    "External isolated mail/auth fixtures required. No tests run.\n",
  );
  process.exitCode = 1;
}
