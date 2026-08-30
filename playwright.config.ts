import { defineConfig, devices } from '@playwright/test';

const port = 9110;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 30_000,
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 7'],
      },
    },
  ],
  webServer: {
    command: 'node dist/apps/server/src/index.js',
    url: `${baseURL}/healthz`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      ...process.env,
      TTLAB_SERVER_PORT: String(port),
      TTLAB_PUBLIC_BASE_URL: baseURL,
      TTLAB_WEB_ROOT: '.',
      TTLAB_LOG_DIR: 'e2e-data/logs',
      TTLAB_LOG_FLUSH_MS: '100',
      TTLAB_CLIENT_AUTH_ENABLED: '0',
      TTLAB_AGENT_ENABLED: '0',
    },
  },
});
