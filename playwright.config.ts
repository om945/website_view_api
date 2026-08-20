import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "browser.test.ts",
  timeout: 30_000,
  use: { baseURL: "http://localhost:3100" },
  webServer: {
    command: "bun --no-env-file src/test-server.ts",
    url: "http://localhost:3100/ready",
    timeout: 30_000,
    reuseExistingServer: false,
    env: {
      NODE_ENV: "test",
      TEST_PORT: "3100",
      TEST_BASE_URL: "http://localhost:3100",
    },
  },
});
