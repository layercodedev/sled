import type { ClaudeContainer } from "../src/index";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    CLAUDE_CONTAINER: ClaudeContainer | null;
    LOCAL_AGENT_MANAGER_URL: string;
  }
}
