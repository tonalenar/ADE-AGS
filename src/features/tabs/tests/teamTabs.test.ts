import { describe, expect, it } from "vitest";

import type { UnifiedConversation } from "@/features/chat/unified/types";
import { gridTabs } from "@/features/canvas/gridMode";
import { gridPlacements, type GridRect } from "@/features/canvas/gridMode";
import { agentKey } from "@/features/tabs/layout/layoutTree";
import { placementsFrom } from "@/features/tabs/layout/layoutStore";
import { teamGridRefs, teamGroups, teamMenuActions, terminalRefs } from "@/features/tabs/teamTabs";

const conv = (ref: string, over: Partial<UnifiedConversation> = {}): UnifiedConversation => ({
  ref, kind: ref.startsWith("thread:") ? "protocol" : "pty", agentId: "claude-code", cwd: "/p", title: ref,
  lead: false, subagent: false, starting: false, openedAt: 1, ...over,
});

const lead = conv("a", { teamId: "T", lead: true, origin: "canvas" });
const second = conv("b", { teamId: "T", role: "qa", origin: "canvas" });
const proto = conv("thread:x", { teamId: "T", role: "backend", origin: "canvas" });
const alone = conv("z");

describe("teamGroups", () => {
  it("agrupa por time: orquestrador primeiro, depois a ordem dada, com a origem do time", () => {
    const groups = teamGroups([second, alone, proto, lead]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ teamId: "T", origin: "canvas", lead: "a" });
    expect(groups[0]!.refs).toEqual(["a", "b", "thread:x"]);
    expect(groups[0]!.protocol).toEqual(["thread:x"]);
  });

  it("quem não está em time fica de fora", () => {
    expect(teamGroups([alone])).toEqual([]);
  });

  it("time sem orquestrador (coroa tirada) continua agrupado", () => {
    const g = teamGroups([second, proto]);
    expect(g[0]).toMatchObject({ teamId: "T", lead: null });
    expect(g[0]!.refs).toEqual(["b", "thread:x"]);
  });
});

describe("teamGridRefs", () => {
  it("o time da aba ativa, protocolo incluído", () => {
    expect(teamGridRefs([lead, second, proto, alone], "b")).toEqual(["a", "b", "thread:x"]);
  });
  it("aba fora de time ou sem conversa: null", () => {
    expect(teamGridRefs([lead, second, alone], "z")).toBeNull();
    expect(teamGridRefs([lead, second], "nada")).toBeNull();
    expect(teamGridRefs([lead, second], null)).toBeNull();
  });
  it("terminalRefs tira o que não tem terminal", () => {
    expect(terminalRefs(["a", "thread:x", "b"])).toEqual(["a", "b"]);
  });
});

describe("a grade com protocolo não mexe nos terminais", () => {
  const rect: GridRect = { left: 0, top: 0, width: 10, height: 10 };
  it("gridTabs aceita um time de um terminal e um protocolo (2 panes)", () => {
    expect(gridTabs({ on: true, mission: null, team: ["a", "thread:x"], mode: "tabs", tabIds: [] })).toEqual(["a", "thread:x"]);
  });
  it("gridPlacements e placementsFrom só ubicam terminais; a ref de protocolo não vira placement", () => {
    const slots = { "grid:a": rect, "grid:thread:x": rect };
    const p = placementsFrom({ layout: null, slots, activeTabId: "a", activeViewId: null, mode: "tabs", liveRects: {}, grid: ["a", "thread:x"], chat: null });
    expect([...p.visible.keys()]).toEqual([agentKey("a")]);
    expect([...gridPlacements(terminalRefs(["a", "thread:x"]), slots).keys()]).toEqual(["a"]);
  });
});

describe("teamMenuActions", () => {
  it("sem time: criar; e ligar ao time ativo quando há um", () => {
    expect(teamMenuActions([lead, second, alone], "z", null)).toEqual(["create"]);
    expect(teamMenuActions([lead, second, alone], "z", "T")).toEqual(["create", "link"]);
  });
  it("orquestrador: tirar a coroa", () => {
    expect(teamMenuActions([lead, second], "a", "T")).toEqual(["unlead"]);
  });
  it("integrante: desligar; e tornar orquestrador se o time ficou sem", () => {
    expect(teamMenuActions([lead, second], "b", "T")).toEqual(["unlink"]);
    expect(teamMenuActions([second, proto], "b", "T")).toEqual(["unlink", "lead"]);
  });
  it("protocolo não vira orquestrador por aqui (a coroa é de terminal)", () => {
    expect(teamMenuActions([second, proto], "thread:x", "T")).toEqual(["unlink"]);
  });
});
