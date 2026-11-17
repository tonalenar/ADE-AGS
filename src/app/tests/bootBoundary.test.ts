import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("fronteira acima do Boot", () => {
  it("o ThemeProvider e o Boot ficam dentro de um PanelBoundary", () => {
    const src = readFileSync(path.join(ROOT, "src/main.tsx"), "utf8");
    expect(src).toContain("PanelBoundary");
    expect(src).toMatch(/PanelBoundary[\s\S]*ThemeProvider[\s\S]*Boot/);
  });
});
