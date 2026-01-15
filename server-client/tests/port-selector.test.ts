import { describe, expect, it } from "vitest";
import { findAvailablePort } from "../src/portSelector";

describe("findAvailablePort", () => {
  it("skips reserved ports and returns the first available", async () => {
    const checked: number[] = [];
    expect(
      await findAvailablePort({
        startPort: 4000,
        host: "127.0.0.1",
        reservedPorts: new Set([4000, 4001]),
        isPortAvailable: async ({ port }) => {
          checked.push(port);
          return port === 4002;
        },
      }),
    ).toBe(4002);
    expect(checked).toEqual([4002]);
  });

  it("throws when no ports are available", async () => {
    await expect(
      findAvailablePort({
        startPort: 5000,
        host: "127.0.0.1",
        maxAttempts: 2,
        isPortAvailable: async () => false,
      }),
    ).rejects.toThrow(/No available port/);
  });
});
