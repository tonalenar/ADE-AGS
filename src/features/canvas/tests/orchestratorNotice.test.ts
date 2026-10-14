import { describe, expect, it } from "vitest";
import { addEdge, emptyBoard, reconcile, setRole, toggleOrchestrator } from "../board";
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
    expect(text).toContain("Codex (Codex; sem papel definido)");
    expect(text).toContain("ags peer role");
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

  it("cita o papel e o subagente e só pede decisão dos que estão sem papel", () => {
    const b = setRole(setRole(board(), "b", "QA / Tests", true), "c", "Backend", false);
    const text = orchestratorNotice(b, tabs, "a")!;
    expect(text).toContain("Codex (Codex; papel: QA / Tests, subagente)");
    expect(text).toContain("papel: Backend");
    expect(text).not.toContain("SEM PAPEL");
  });

  it("definir o papel de um ligado avisa o orquestrador de novo", () => {
    forgetOrchestrator("a");
    const b = board();
    expect(shouldAnnounce(b, "a")).toBe(true);
    expect(shouldAnnounce(setRole(b, "b", "QA / Tests", false), "a")).toBe(true);
  });

  it("setRole grava e limpa o papel e o subagente", () => {
    const b = setRole(board(), "b", "QA", true);
    expect(b.roles.b).toBe("QA");
    expect(b.subagents).toEqual(["b"]);
    const cleared = setRole(b, "b", null, false);
    expect(cleared.roles.b).toBeUndefined();
    expect(cleared.subagents).toEqual([]);
  });
});
