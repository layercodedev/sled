import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeCwd } from "../src/local-agent-manager";

describe("normalizeCwd", () => {
  it("expands ~ and resolves existing directories", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-home-"));
    const project = path.join(home, "project");
    fs.mkdirSync(project, { recursive: true });
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(normalizeCwd("~")).toBe(home);
      expect(normalizeCwd("~/project")).toBe(project);
      expect(normalizeCwd(project)).toBe(project);
    } finally {
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns null for missing directories", () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-home-"));
    const missing = path.join(home, "missing");
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(normalizeCwd(missing)).toBeNull();
      expect(normalizeCwd("~/missing")).toBeNull();
    } finally {
      console.warn = originalWarn;
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
