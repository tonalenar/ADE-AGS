import { describe, expect, it } from "vitest";
import { addEdge, emptyBoard, reconcile, toggleOrchestrator } from "../board";
import { forgetOrchestrator, linkedPeers, orchestratorNotice, shouldAnnounce } from "../orchestratorNotice";

const tabs = [
  { id: "a", title: "Claude Code — proj", agentLabel: "Claude Code" },
  { id: "b", title: "Codex — proj", agentLabel: "Codex" },
  { id: "c", title: "Antigravity — proj", agentLabel: "Antigravity" },
];

function board() {
  let b = reconcile(emptyBoard(), ["a", "b", "c"]);
  b = toggleOrchestrator(b, "a");
  return addEdge(addEdge(b, "a", "b"), "c", "a");
}

describe("aviso ao orquestrador", () => {
  it("lista quem está ligado, pelos dois lados da corda", () => {
    expect(linkedPeers(board(), "a").sort()).toEqual(["b", "c"]);
  });

  it("o texto cita os terminais e os comandos de peers", () => {
    const text = orchestratorNotice(board(), tabs, "a")!;
    expect(text).toContain("2 terminais conectados");
    expect(text).toContain("Codex (Codex)");
    expect(text).toContain("ags peer ask");
  });

  it("não avisa quem não é orquestrador nem quem está sozinho", () => {
    expect(orchestratorNotice(board(), tabs, "b")).toBeNull();
    const alone = toggleOrchestrator(reconcile(emptyBoard(), ["a"]), "a");
    expect(orchestratorNotice(alone, tabs, "a")).toBeNull();
  });

  it("só repete o aviso quando a lista de ligados muda", () => {
    forgetOrchestrator("a");
    const b = board();
    expect(shouldAnnounce(b, "a")).toBe(true);
    expect(shouldAnnounce(b, "a")).toBe(false);
    const more = reconcile(b, ["a", "b", "c", "d"]);
    expect(shouldAnnounce(addEdge(more, "a", "d"), "a")).toBe(true);
  });
});
