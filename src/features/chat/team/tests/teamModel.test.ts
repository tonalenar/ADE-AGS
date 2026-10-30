import { describe, expect, it } from "vitest";

import type { TeamFeedItem, TeamMember, TeamView } from "../ipc";
import {
  CLOSED, LEAD_ONLY_PREFIX, agentMono, applyMention, branchFor, conversationAccess, defaultPolicy, delegationCards, deliveries,
  memberState, mentionOptions, mentionQuery, orchestratorState, placeOf, rosterNotice, rosterRows, rosterSignature, routeMessage,
  sidebarGrouping, stateTone, takenRefs, teamLedBy, type LiveInput,
} from "../teamModel";

function member(ref: string, agentId: string, role: string, extra: Partial<TeamMember> = {}): TeamMember {
  return {
    teamId: "t1", member: ref, agentId, label: agentId, role, model: null, policy: defaultPolicy(role), branch: null, worktree: null,
    origin: "existing", position: 0, createdAt: 1, updatedAt: 1, subagent: false, ...extra,
  };
}

const TEAM: TeamView = {
  id: "t1", orchestrator: "tab-lead", agentId: "claude-code", label: "Claude Code", cwd: "/repo", title: "Modo chat",
  createdAt: 1, updatedAt: 1, headcount: 4,
  members: [
    member("thread:x", "codex", "frontend", { label: "Codex", branch: "team/ui", policy: "edits" }),
    member("tab-g", "gemini-cli", "backend", { label: "Gemini CLI", branch: "team/backend" }),
    member("tab-k", "kimi", "qa", { label: "Kimi", policy: "read" }),
  ],
};

const live = (patch: Partial<LiveInput> = {}): LiveInput => ({ open: true, working: false, awaiting: false, question: false, ...patch });

function feed(id: number, kind: TeamFeedItem["kind"], ref: string, state = "delivered", handoff: number | null = null): TeamFeedItem {
  return { id, kind, member: ref, memberName: ref, task: `tarefa ${id}`, state, at: id, handoff };
}

describe("quem é quem no time", () => {
  it("acha o time pelo orquestrador ou pelo integrante", () => {
    expect(placeOf([TEAM], "tab-lead")).toEqual({ team: TEAM, member: null });
    expect(placeOf([TEAM], "thread:x")?.member?.role).toBe("frontend");
    expect(placeOf([TEAM], "tab-zz")).toBeNull();
    expect(teamLedBy([TEAM], "thread:x")).toBeNull();
    expect(takenRefs([TEAM])).toEqual(new Set(["tab-lead", "thread:x", "tab-g", "tab-k"]));
  });

  it("os padrões seguem a prancheta", () => {
    expect(defaultPolicy("reviewer")).toBe("read");
    expect(defaultPolicy("frontend")).toBe("ask");
    expect(branchFor("frontend")).toBe("team/ui");
    expect(branchFor("qa")).toBe("team/tests");
    expect(branchFor("Revisão de Código")).toBe("team/revisao-de-codigo");
    expect(agentMono("codex", "Codex")).toBe("X");
    expect(agentMono("gemini-cli", "Gemini CLI")).toBe("G");
  });

  it("a conversa nova nunca tem mais acesso do que a política deixa", () => {
    expect(conversationAccess("read", "claude-code")).toEqual({ access: "ask", plan: true });
    expect(conversationAccess("read", "codex")).toEqual({ access: "ask", plan: false });
    expect(conversationAccess("edits", "codex")).toEqual({ access: "edits", plan: false });
    expect(conversationAccess("full", "codex")).toEqual({ access: "full", plan: false });
  });
});

describe("estado", () => {
  it("o que pede a pessoa vem antes de trabalhar, e a entrega conta só depois da última tarefa", () => {
    expect(memberState(CLOSED, [], "tab-k")).toBe("closed");
    expect(memberState(live({ awaiting: true, working: true }), [], "tab-g")).toBe("approval");
    expect(memberState(live({ working: true }), [], "tab-g")).toBe("working");
    expect(memberState(live(), [feed(1, "delegation", "tab-k"), feed(2, "delivery", "tab-k")], "tab-k")).toBe("delivered");
    expect(memberState(live(), [feed(2, "delivery", "tab-k"), feed(3, "delegation", "tab-k")], "tab-k")).toBe("idle");
    expect(memberState(live(), [feed(3, "delegation", "tab-k", "queued")], "tab-k")).toBe("queued");
  });

  it("o orquestrador coordena enquanto alguém do time trabalha", () => {
    expect(orchestratorState(live(), ["working", "idle"])).toBe("coordinating");
    expect(orchestratorState(live(), ["idle", "delivered"])).toBe("idle");
    expect(orchestratorState(live({ working: true }), [])).toBe("coordinating");
  });

  it("cada estado tem a cor do tema, sem hex", () => {
    for (const s of ["working", "approval", "delivered", "idle"] as const) expect(stateTone(s)).not.toMatch(/#/);
    expect(stateTone("delivered")).toContain("emerald");
  });
});

describe("a lista do painel", () => {
  it("o orquestrador primeiro, com modelo, papel, estado, política e branch", () => {
    const rows = rosterRows(TEAM, [], {
      nameOf: (ref) => (ref === "tab-lead" ? "Claude Code" : null),
      liveOf: (ref) => (ref === "thread:x" ? live({ working: true }) : live()),
      modelOf: (ref) => (ref === "tab-lead" ? "Opus 5.5 · alto" : null),
      branchOf: (ref) => (ref === "tab-lead" ? "feat/modo-chat" : null),
      orchestratorPolicy: "full",
    });
    expect(rows.map((r) => [r.name, r.role, r.state, r.policy, r.branch])).toEqual([
      ["Claude Code", "orchestrator", "coordinating", "full", "feat/modo-chat"],
      ["Codex", "frontend", "working", "edits", "team/ui"],
      ["Gemini CLI", "backend", "idle", "ask", "team/backend"],
      ["Kimi", "qa", "idle", "read", null],
    ]);
    expect(rows[0]!.model).toBe("Opus 5.5 · alto");
    expect(rows[1]!.isThread).toBe(true);
  });
});

describe("o fio do orquestrador", () => {
  it("um cartão por integrante com a última tarefa, e entregou quando a entrega veio depois", () => {
    const items = [
      feed(1, "delegation", "thread:x"),
      feed(2, "delegation", "tab-g"),
      feed(3, "delegation", "thread:x"),
      feed(4, "delivery", "thread:x", "delivered", 9),
    ];
    const cards = delegationCards(items, () => "working");
    expect(cards.map((c) => [c.member, c.task, c.state, c.handoff])).toEqual([
      ["tab-g", "tarefa 2", "working", null],
      ["thread:x", "tarefa 3", "delivered", 9],
    ]);
    expect(deliveries(items).map((d) => d.id)).toEqual([4]);
  });
});

describe("o composer", () => {
  const options = TEAM.members.map((m) => ({ ref: m.member, name: m.label, agentId: m.agentId, role: m.role }));

  it("o @ no cursor vira o apelido do integrante", () => {
    expect(mentionQuery("fala @co", 8)).toEqual({ start: 5, query: "co" });
    expect(mentionQuery("email@x", 7)).toBeNull();
    expect(applyMention("fala @co", 8, "Codex")).toEqual({ text: "fala @codex ", caret: 12 });
    expect(mentionOptions(options, "gem").map((o) => o.ref)).toEqual(["tab-g"]);
    expect(mentionOptions(options, "qa").map((o) => o.ref)).toEqual(["tab-k"]);
  });

  it("@integrante vai só para ele; o resto vai ao orquestrador", () => {
    expect(routeMessage("@codex arruma o botão", "team", TEAM, options, null)).toEqual({ to: "thread:x", text: "arruma o botão", direct: true });
    expect(routeMessage("@ninguem oi", "team", TEAM, options, null)).toEqual({ to: "tab-lead", text: "@ninguem oi", direct: false });
    expect(routeMessage("monta tudo", "team", TEAM, options, "[ADE AGS] time")).toEqual({ to: "tab-lead", text: "[ADE AGS] time\n\nmonta tudo", direct: false });
    expect(routeMessage("só você", "lead", TEAM, options, "[ADE AGS] time").text).toBe(`${LEAD_ONLY_PREFIX}\nsó você`);
  });

  it("o resumo do time diz quem é quem e como delegar; muda quando o time muda", () => {
    const notice = rosterNotice(TEAM, () => null, (r) => r.toUpperCase(), (p) => p);
    expect(notice).toContain("Codex (codex; FRONTEND; edits, team/ui)");
    expect(notice).toContain("ags peer tell");
    const before = rosterSignature(TEAM);
    expect(rosterSignature({ ...TEAM, members: TEAM.members.slice(1) })).not.toBe(before);
    expect(rosterNotice({ ...TEAM, members: [] }, () => null, (r) => r, (p) => p)).toContain("ninguém ligado");
  });
});

describe("a sidebar", () => {
  it("os integrantes ficam sob o orquestrador e saem da lista principal", () => {
    const grouped = sidebarGrouping(["tab-lead", "thread:x", "tab-k", "tab-solta"], [TEAM]);
    expect(grouped.groups).toEqual({ "tab-lead": ["thread:x", "tab-k"] });
    expect([...grouped.nested]).toEqual(["thread:x", "tab-k"]);
  });

  it("sem o cartão do orquestrador, o integrante continua solto", () => {
    expect(sidebarGrouping(["thread:x"], [TEAM]).nested.size).toBe(0);
  });
});

describe("o modelo do cartão do integrante", () => {
  it("mostra o de agora (modelo · esforço) e cai no gravado ao ligar", () => {
    const base = { nameOf: () => null, liveOf: () => live(), branchOf: () => null, orchestratorPolicy: null };
    const withLive = rosterRows(TEAM, [], { ...base, modelOf: (ref) => (ref === "thread:x" ? "claude-haiku-5-5 · xhigh" : null) });
    expect(withLive[1]!.model).toBe("claude-haiku-5-5 · xhigh");
    const without = rosterRows({ ...TEAM, members: [{ ...TEAM.members[0]!, model: "gpt-x" }] }, [], { ...base, modelOf: () => null });
    expect(without[1]!.model).toBe("gpt-x");
  });
});
