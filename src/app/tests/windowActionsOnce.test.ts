import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("WindowControls", () => {
  it("o efeito de maximizado não depende da identidade da janela a cada render", () => {
    const src = readFileSync(path.join(ROOT, "src/app/WindowLights.tsx"), "utf8");
    expect(src).toMatch(/useEffect\(\(\) => \{[\s\S]*getCurrentWindow\(\)[\s\S]*\}, \[\]\)/);
  });
});
