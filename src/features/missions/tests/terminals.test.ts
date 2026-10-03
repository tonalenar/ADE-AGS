import { beforeEach, describe, expect, it } from "vitest";

import { buildMissionTeam, emptyBoard } from "@/features/canvas/board";
import { boardKey, boardKeyOfTab, missionBoardKey, missionOfKey, missionOfTab, useCanvasStore } from "@/features/canvas/store";
import type { FunctionalRole, Squad } from "@/features/squads/types";

import { entryTab, finishedMissionTabs, missionIndex, tabsByMission } from "../groups";

describe("finishedMissionTabs", () => {
  const missions = [
    { id: "vivo", status: "running" },
    { id: "feito", status: "done" },
    { id: "cancelado", status: "cancelled" },
    { id: "rascunho", status: "draft" },
  ];
  const index = { a: "vivo", b: "feito", c: "cancelado", d: "rascunho" };
  it("só devolve as abas de missões terminadas, nunca as vivas nem as soltas", () => {
    const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "solta" }];
    expect(finishedMissionTabs(missions, index, tabs)).toEqual(["b", "c"]);
  });
});
import { LEAD_NAME, accountsNeedingLogin, briefingFor, leadBriefing, memberBriefing, teamOf, uniqueNames } from "../terminals";

describe("accountsNeedingLogin", () => {
  const accounts = [
    { id: "a", name: "Principal", loggedIn: true, kind: "login" as const },
    { id: "b", name: "Secundária", loggedIn: false, kind: "login" as const },
    { id: "c", name: "Chave", loggedIn: false, kind: "api_key" as const },
  ];
  it("aponta só as contas de login sem sessão, sem repetir", () => {
    expect(accountsNeedingLogin(["a", "b", "b", null, undefined], accounts)).toEqual(["Secundária"]);
  });
  it("conta de chave de API e conta do sistema não precisam de login", () => {
    expect(accountsNeedingLogin(["c", null, "x"], accounts)).toEqual([]);
  });
});

const roles: FunctionalRole[] = [
  { id: "backend", label: "Backend", description: "API e dados", instructions: "Implemente a API." },
  { id: "qa", label: "QA", description: "Testes", instructions: "Escreva e rode testes." },
];

const squad = (members: { roleId: string; accountId?: string | null; autoAccount?: boolean }[]): Squad => ({
  id: "s1", name: "Time", description: "", createdAt: 0, updatedAt: 0, available: true, unavailableReasons: [],
  lead: { agentId: "claude-code", model: null, accountId: null, autoAccount: true, complexity: null, availability: "available", unavailableReason: null },
  members: members.map((m) => ({
    roleId: m.roleId, agentId: "codex", model: null, accountId: m.accountId ?? null, autoAccount: m.autoAccount ?? true,
    complexity: null, isolateDefault: false, availability: "available", unavailableReason: null,
  })),
});

describe("el equipo de una misión", () => {
  it("nombres únicos: un papel repetido queda numerado", () => {
    expect(uniqueNames(["Backend", "QA", "Backend", "backend"])).toEqual(["Backend", "QA", "Backend 2", "backend 3"]);
    expect(uniqueNames([])).toEqual([]);
  });

  it("un integrante por miembro, con su papel y su cuenta (la automática no fija ninguna)", () => {
    const team = teamOf(squad([{ roleId: "backend", autoAccount: false, accountId: "acc-1" }, { roleId: "qa" }, { roleId: "desaparecido" }]), roles);
    expect(team.map((m) => m.name)).toEqual(["Backend", "QA", "desaparecido"]);
    expect(team[0]).toMatchObject({ agentId: "codex", accountId: "acc-1", roleLabel: "Backend", roleInstructions: "Implemente a API." });
    expect(team[1].accountId).toBeNull();
    expect(team[2].roleLabel).toBe("desaparecido");
    expect(teamOf(null, roles)).toEqual([]);
  });

  it("el orquestador lee el objetivo, a quién tiene y cómo coordinarlos", () => {
    const team = teamOf(squad([{ roleId: "backend" }, { roleId: "qa" }]), roles);
    const text = leadBriefing({ title: "Meu app", objective: "Criar um login" }, team);
    expect(text).toContain('missão "Meu app"');
    expect(text).toContain("Criar um login");
    expect(text).toContain("- Backend — Backend: API e dados");
    expect(text).toContain("- QA — QA: Testes");
    expect(text).toContain("ccode peer ask");
    expect(text).toContain("ccode notify");
  });

  it("sin equipo, el orquestador aprende a sumar agentes", () => {
    const text = leadBriefing({ title: "T", objective: "O" }, []);
    expect(text).toContain("ccode peer recruit");
    expect(text).not.toContain("SUA EQUIPE");
  });

  it("cada integrante lee su papel, quién lo dirige y cómo avisarle", () => {
    const [backend] = teamOf(squad([{ roleId: "backend" }]), roles);
    const text = memberBriefing({ title: "Meu app", objective: "Criar um login" }, backend);
    expect(text).toContain(`dirigida pelo orquestrador "${LEAD_NAME}"`);
    expect(text).toContain("SEU PAPEL: Backend — API e dados");
    expect(text).toContain("Implemente a API.");
    expect(text).toContain(`ccode peer tell "${LEAD_NAME}"`);
    expect(text).not.toMatch(/\n\n\n/);
  });
});

describe("el canvas de la misión", () => {
  it("el orquestador arriba con corona, el equipo debajo, conectado y con su papel", () => {
    const board = buildMissionTeam(emptyBoard(), "lead", [{ tabId: "m1", roleId: "Backend" }, { tabId: "m2", roleId: "QA" }]);
    expect(board.orchestrators).toEqual(["lead"]);
    expect(Object.keys(board.nodes).sort()).toEqual(["lead", "m1", "m2"]);
    expect(board.edges.map((e) => [e.a, e.b]).sort()).toEqual([["lead", "m1"], ["lead", "m2"]]);
    expect(board.roles).toEqual({ m1: "Backend", m2: "QA" });
    const lead = board.nodes.lead;
    for (const id of ["m1", "m2"]) expect(board.nodes[id].y).toBeGreaterThan(lead.y + lead.h - 1);
    // Los dos del equipo no se tapan entre sí.
    expect(board.nodes.m1.x).not.toBe(board.nodes.m2.x);
  });

  it("sin papel no se marca, y repetir no duplica ni conexiones ni la corona", () => {
    const once = buildMissionTeam(emptyBoard(), "lead", [{ tabId: "m1" }]);
    expect(once.roles).toEqual({});
    const twice = buildMissionTeam(once, "lead", [{ tabId: "m1" }]);
    expect(twice.edges).toHaveLength(1);
    expect(twice.orchestrators).toEqual(["lead"]);
  });
});

describe("a qué misión pertenece una pestaña", () => {
  beforeEach(() => useCanvasStore.setState({ boards: {}, modes: {}, liveRects: {} }));

  it("la clave del canvas de la misión cuelga de la de su carpeta y se lee de vuelta", () => {
    const key = missionBoardKey("C:/p/app", "m-1");
    expect(key.startsWith(boardKey("C:/p/app"))).toBe(true);
    expect(missionOfKey(key)).toBe("m-1");
    expect(missionOfKey(boardKey("C:/p/app"))).toBeNull();
    expect(missionOfKey(null)).toBeNull();
  });

  it("una pestaña es de la misión cuyo canvas la tiene como nodo; si no, de su carpeta", () => {
    const key = missionBoardKey("C:/p/app", "m-1");
    const boards = { [key]: buildMissionTeam(emptyBoard(), "lead", [{ tabId: "m1" }]) };
    expect(boardKeyOfTab({ id: "lead", cwd: "C:/p/app" }, boards)).toBe(key);
    expect(boardKeyOfTab({ id: "m1", cwd: "C:/p/app" }, boards)).toBe(key);
    expect(boardKeyOfTab({ id: "suelta", cwd: "C:/p/app" }, boards)).toBe(boardKey("C:/p/app"));
    expect(missionOfTab({ id: "m1", cwd: "C:/p/app" }, boards)).toBe("m-1");
    expect(missionOfTab({ id: "suelta", cwd: "C:/p/app" }, boards)).toBeNull();
  });

  it("el índice y el agrupado por misión", () => {
    const boards = { [missionBoardKey("C:/p", "A")]: buildMissionTeam(emptyBoard(), "a1", [{ tabId: "a2" }]), [missionBoardKey("C:/p", "B")]: buildMissionTeam(emptyBoard(), "b1", []) };
    const tabs = [{ id: "a1", cwd: "C:/p" }, { id: "libre", cwd: "C:/p" }, { id: "a2", cwd: "C:/p" }, { id: "b1", cwd: "C:/p" }];
    const index = missionIndex(boards, tabs);
    expect(index).toEqual({ a1: "A", a2: "A", b1: "B" });
    expect(tabsByMission(index, tabs)).toEqual({ A: ["a1", "a2"], B: ["b1"] });
  });

  it("al abrir una misión se va al orquestador si está abierto, si no a la primera", () => {
    expect(entryTab(["lead"], ["m1", "lead"])).toBe("lead");
    expect(entryTab(["cerrado"], ["m1", "m2"])).toBe("m1");
    expect(entryTab([], [])).toBeNull();
  });
});

describe("briefingFor", () => {
  const text = "Linha um\n\nOBJETIVO\n- primeiro\n- segundo";
  it("Claude Code recebe o texto com seus saltos de linha", () => {
    expect(briefingFor("claude-code", text)).toBe(text);
  });
  it("as outras TUIs recebem tudo em uma linha, sem vazias nem marcadores", () => {
    const flat = briefingFor("codex", text);
    expect(flat).toBe("Linha um | OBJETIVO | primeiro | segundo");
    expect(flat).not.toContain("\n");
  });
});
