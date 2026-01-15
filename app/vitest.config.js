import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
export default defineWorkersConfig({
  test: {
    pool: "@cloudflare/vitest-pool-workers",
    include: ["tests/**/*.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            LOCAL_AGENT_MANAGER_URL: "http://127.0.0.1:8788",
            CLAUDE_CONTAINER: null,
          },
        },
      },
    },
  },
});
