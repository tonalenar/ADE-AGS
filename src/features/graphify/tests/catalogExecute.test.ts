import { describe, expect, it, vi } from "vitest";

import { executeRenderedCommand, previewIsCurrent, renderCurrentLine } from "../catalogExecute";
import type { GraphifyChoice } from "../ipc";

const choice: GraphifyChoice = { flags: [], args: { backend: "kuzu" } };

describe("executeRenderedCommand", () => {
  it("roda o render atual, não a linha antiga do preview", async () => {
    const stalePreview = "graphify extract --backend neo4j";
    const current = "graphify extract --backend kuzu";
    const render = vi.fn(async () => current);
    const run = vi.fn(async (line: string) => ({ ok: true, code: 0, output: line }));

    const result = await executeRenderedCommand(render, run, "extract", choice);

    expect(render).toHaveBeenCalledWith("extract", choice);
    expect(run).toHaveBeenCalledWith(current);
    expect(run).not.toHaveBeenCalledWith(stalePreview);
    expect(result.output).toBe(current);
  });
});

describe("renderCurrentLine", () => {
  it("pede o render atual, não a linha antiga do preview", async () => {
    const render = vi.fn(async () => "graphify extract --backend kuzu");
    await expect(renderCurrentLine(render, "extract", choice)).resolves.toBe("graphify extract --backend kuzu");
    expect(render).toHaveBeenCalledWith("extract", choice);
  });
});

describe("previewIsCurrent", () => {
  it("descarta resposta velha quando já pediram outra geração", () => {
    expect(previewIsCurrent(2, 1)).toBe(false);
    expect(previewIsCurrent(2, 2)).toBe(true);
  });
});
