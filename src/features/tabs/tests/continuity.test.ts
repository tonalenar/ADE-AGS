import { describe, expect, it } from "vitest";
import { pendingForClaude, requestContinuity, takeContinuity } from "../continuity";
import type { AiMemoryHandoff } from "@/features/memory/aiMemory";

const row = (id: string, cwd: string | null, to_agent: string | null = null): AiMemoryHandoff => ({
  id, cwd, to_agent, from_agent: "codex", created_at_ms: 1,
});

describe("continuidade apenas em nova aba", () => {
  it("consome a confirmação uma vez e não reaplica em restart/reattach", () => {
    requestContinuity("new-tab");
    expect(takeContinuity("other-tab")).toBe(false);
    expect(takeContinuity("new-tab")).toBe(true);
    expect(takeContinuity("new-tab")).toBe(false);
    expect(takeContinuity()).toBe(false);
  });
  it("isola pasta, fronteira de caminho e destinatário", () => {
    const rows = [row("same", "/repo/app/", "claude-code"), row("ancestor", "/repo"),
      row("sibling", "/repo/application"), row("other", "/repo/app", "codex"), row("manual", null)];
    expect(pendingForClaude(rows, "/repo/app").map((r) => r.id)).toEqual(["same", "ancestor", "manual"]);
    expect(rows).toHaveLength(5);
  });
  it("normaliza separadores e letras de unidade no Windows", () => {
    expect(pendingForClaude([row("win", "C:\\Repo\\App\\")], "c:/repo/app/sub")).toHaveLength(1);
    expect(pendingForClaude([row("other", "C:\\Repo\\App")], "c:/repo/application")).toEqual([]);
  });
});
