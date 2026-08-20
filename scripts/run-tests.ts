const bun = process.execPath;
const testEnvironment: Record<string, string> = { ...process.env } as Record<string, string>;
const envContents = await Bun.file(".env.test").text();
for (const line of envContents.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const separator = trimmed.indexOf("=");
  if (separator < 1) continue;
  const key = trimmed.slice(0, separator).trim();
  const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
  testEnvironment[key] = value;
}
const baseUrl = testEnvironment.TEST_BASE_URL ?? "http://localhost:3100";
const server = Bun.spawn([bun, "--no-env-file", "src/test-server.ts"], { env: testEnvironment, stdout: "inherit", stderr: "inherit" });

async function waitForReady() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/ready`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await Bun.sleep(250);
  }
  throw new Error(`Test server did not become ready at ${baseUrl}/ready`);
}

let exitCode = 1;
try {
  await waitForReady();
  const tests = Bun.spawn([bun, "test", "--no-env-file", "--path-ignore-patterns=tests/browser.test.ts", "tests/unit.test.ts"], { env: testEnvironment, stdout: "inherit", stderr: "inherit" });
  exitCode = await tests.exited;
} finally {
  server.kill();
  await server.exited;
}
process.exit(exitCode);
