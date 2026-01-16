import type { SledAgent } from "../src/index";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    SLED_AGENT: SledAgent | null;
    LOCAL_AGENT_MANAGER_URL: string;
  }
}
