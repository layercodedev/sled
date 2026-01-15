// Durable Object storage SQL minimal shape (D1Database is in worker-configuration.d.ts)
interface DurableObjectSqlPreparedStatement {
  bind(...values: unknown[]): DurableObjectSqlPreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

interface DurableObjectStorageSql {
  exec(sql: string, ...params: unknown[]): { results?: Array<Record<string, unknown>> };
  prepare(sql: string): DurableObjectSqlPreparedStatement;
}

// Cloudflare Workers test module types (used by @cloudflare/vitest-pool-workers)
declare module "cloudflare:test" {
  export const SELF: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}
