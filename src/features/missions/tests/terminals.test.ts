import { beforeEach, describe, expect, it } from "vitest";

import { buildMissionTeam, emptyBoard, gridCell, placeInNextGridCell, reconcile } from "@/features/canvas/board";
import { GAP } from "@/features/canvas/geometry";
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
import { LEAD_NAME, MAX_EXTRA_TERMINALS, accountsNeedingLogin, briefingFor, leadBriefing, memberBriefing, teamOf, uniqueNames } from "../terminals";

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
    expect(text).toContain("ags peer ask");
    expect(text).toContain("ags notify");
  });

  it("sin equipo, el orquestador aprende a sumar agentes", () => {
    const text = leadBriefing({ title: "T", objective: "O" }, []);
    expect(text).toContain("ags peer recruit");
    expect(text).not.toContain("SUA EQUIPE");
  });

  it("con o equipe aberto, o orquestador também sabe que pode abrir mais terminais, até um limite", () => {
    const team = teamOf(squad([{ roleId: "backend" }]), roles);
    const text = leadBriefing({ title: "T", objective: "O" }, team);
    expect(text).toContain("MAIS TERMINAIS");
    expect(text).toContain('ags peer recruit "<nome>"');
    expect(text).toContain("SÓ RECRUTE quando a tarefa for independente e paralelizável e a divisão for mais rápida que um agente só; o QG mostra o ganho por missão.");
    expect(text).toContain(`Máximo de ${MAX_EXTRA_TERMINALS} terminais extras`);
  });

  it("cada integrante lee su papel, quién lo dirige y cómo avisarle", () => {
    const [backend] = teamOf(squad([{ roleId: "backend" }]), roles);
    const text = memberBriefing({ title: "Meu app", objective: "Criar um login" }, backend);
    expect(text).toContain(`dirigida pelo orquestrador "${LEAD_NAME}"`);
    expect(text).toContain("SEU PAPEL: Backend — API e dados");
    expect(text).toContain("Implemente a API.");
    expect(text).toContain(`ags peer tell "${LEAD_NAME}"`);
    expect(text).not.toMatch(/\n\n\n/);
  });
});

describe("el canvas de la misión", () => {
  it("el orquestador con corona y el equipo, conectado y con su papel", () => {
    const board = buildMissionTeam(emptyBoard(), "lead", [{ tabId: "m1", roleId: "Backend" }, { tabId: "m2", roleId: "QA" }]);
    expect(board.orchestrators).toEqual(["lead"]);
    expect(Object.keys(board.nodes).sort()).toEqual(["lead", "m1", "m2"]);
    expect(board.edges.map((e) => [e.a, e.b]).sort()).toEqual([["lead", "m1"], ["lead", "m2"]]);
    expect(board.roles).toEqual({ m1: "Backend", m2: "QA" });
  });

  it("grilla de dos filas por columnas: 1 arriba, 2 debajo, 3 a la derecha del 1, 4 debajo del 3, 5 a la derecha", () => {
    const board = buildMissionTeam(emptyBoard(), "lead", [{ tabId: "m1" }, { tabId: "m2" }, { tabId: "m3" }, { tabId: "m4" }]);
    const [p1, p2, p3, p4, p5] = ["lead", "m1", "m2", "m3", "m4"].map((id) => board.nodes[id]);
    // Columna 1: el 2 debajo del 1, misma x.
    expect(p2.x).toBe(p1.x);
    expect(p2.y).toBeGreaterThanOrEqual(p1.y + p1.h);
    // Columna 2: el 3 a la derecha del 1 (misma fila) y el 4 debajo del 3, a la derecha del 2.
    expect(p3.y).toBe(p1.y);
    expect(p3.x).toBeGreaterThanOrEqual(p1.x + p1.w);
    expect(p4.x).toBe(p3.x);
    expect(p4.y).toBe(p2.y);
    // Columna 3 arranca arriba otra vez.
    expect(p5.y).toBe(p1.y);
    expect(p5.x).toBeGreaterThanOrEqual(p3.x + p3.w);
    // Nadie se tapa.
    const boxes = [p1, p2, p3, p4, p5];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
    }
  });

  it("gridCell recorre las columnas de dos en dos", () => {
    expect([0, 1, 2, 3, 4].map((i) => gridCell(i))).toEqual([
      { col: 0, row: 0 }, { col: 0, row: 1 }, { col: 1, row: 0 }, { col: 1, row: 1 }, { col: 2, row: 0 },
    ]);
  });

  it("recruit pula celulas ocupadas por panes abertos antes e depois do time inicial", () => {
    let board = buildMissionTeam(emptyBoard(), "lead", [{ tabId: "m1" }]);
    const lead = board.nodes.lead!;
    const cellW = lead.w + GAP;
    const cellH = lead.h + GAP;
    board = {
      ...board,
      nodes: { ...board.nodes, openedBefore: { x: lead.x + cellW, y: lead.y, w: lead.w, h: lead.h } },
    };
    board = reconcile(board, [...Object.keys(board.nodes), "m2"]);
    board = placeInNextGridCell(board, ["lead", "m1"], "m2");

    const m2Cell = gridCell(3);
    expect(board.nodes.m2).toMatchObject({
      x: lead.x + m2Cell.col * cellW,
      y: lead.y + m2Cell.row * cellH,
    });

    board = {
      ...board,
      nodes: { ...board.nodes, openedAfter: { x: lead.x + 2 * cellW, y: lead.y, w: lead.w, h: lead.h } },
    };
    board = reconcile(board, [...Object.keys(board.nodes), "m3"]);
    board = placeInNextGridCell(board, ["lead", "m1", "m2"], "m3");

    const m3Cell = gridCell(5);
    expect(board.nodes.m3).toMatchObject({
      x: lead.x + m3Cell.col * cellW,
      y: lead.y + m3Cell.row * cellH,
    });

    const boxes = Object.values(board.nodes);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
    }
  });
  it("armar el equipo dos veces deja la misma grilla", () => {
    const once = buildMissionTeam(emptyBoard(), "lead", [{ tabId: "m1" }, { tabId: "m2" }]);
    const twice = buildMissionTeam(once, "lead", [{ tabId: "m1" }, { tabId: "m2" }]);
    expect(twice.nodes).toEqual(once.nodes);
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

describe("leadBriefing com a checagem do que já existe", () => {
  const mission = { title: "Melhoria", objective: "Fazer X" };
  it("inclui os achados antes das instruções de coordenação", () => {
    const findings = ["O QUE JÁ EXISTE (checagem automática, só leitura)", "- src/a.tsx: existe"].join(String.fromCharCode(10));
    const text = leadBriefing(mission, [], findings);
    expect(text).toContain("O QUE JÁ EXISTE");
    expect(text.indexOf("O QUE JÁ EXISTE")).toBeLessThan(text.indexOf("COMO COORDENAR"));
  });
  it("sem achados o briefing é o de sempre", () => {
    expect(leadBriefing(mission, [])).toBe(leadBriefing(mission, [], "  "));
    expect(leadBriefing(mission, [])).not.toContain("O QUE JÁ EXISTE");
  });
});

describe("memória nos briefings", () => {
  const mission = { id: "m-9", title: "Melhoria", objective: "Fazer X" };
  const member = { name: "Backend", agentId: "codex", accountId: null, roleId: "backend", roleLabel: "Backend", roleDescription: "", roleInstructions: "" };
  it("o orquestrador recebe o bloco de memória depois dos achados e antes de coordenar", () => {
    const nl = String.fromCharCode(10);
    const text = leadBriefing(mission, [], ["O QUE JÁ EXISTE", "- x"].join(nl), ["MEMÓRIA DO PROJETO", "- [projeto] k: v"].join(nl));
    expect(text.indexOf("O QUE JÁ EXISTE")).toBeLessThan(text.indexOf("MEMÓRIA DO PROJETO"));
    expect(text.indexOf("MEMÓRIA DO PROJETO")).toBeLessThan(text.indexOf("COMO COORDENAR"));
    expect(leadBriefing(mission, [])).not.toContain("MEMÓRIA DO PROJETO");
  });
  it("cada integrante sabe como buscar na memória da sua missão", () => {
    expect(memberBriefing(mission, member)).toContain("ags memory search");
    expect(memberBriefing(mission, member)).toContain("--mission m-9");
    expect(memberBriefing({ title: "t", objective: "o" }, member)).not.toContain("ags memory search");
  });
  it("o orquestrador consulta entregas registradas antes de perguntar de novo", () => {
    const text = leadBriefing(mission, []);
    expect(text).toContain("Handoff Structured v1");
    expect(text).toContain("task_result");
    expect(text).toContain("Pergunte apenas a lacuna concreta");
  });
  it("a entrega do canvas é uma mensagem final compacta, com atualizações só quando necessárias", () => {
    const text = memberBriefing(mission, member);
    expect(text).toContain("UMA mensagem final curta");
    for (const field of ["resultado", "decisões", "arquivos tocados", "testes", "bloqueios"]) {
      expect(text).toContain(field);
    }
    expect(text).toContain("caminhos relativos");
    expect(text).toContain("Atualizações intermediárias só");
  });
});

describe("sugestão de memória ao terminar", () => {
  it("o orquestrador sabe como sugerir, com o id da missão, e que só sugere", () => {
    const text = leadBriefing({ id: "m-9", title: "T", objective: "O" }, []);
    expect(text).toContain("ags memory suggest --mission m-9");
    expect(text).toContain("SUGERE");
    expect(text).toContain("Nunca sugira segredos");
    expect(text).toContain("--scope workspace");
    expect(text).toContain("Use mission para conhecimento duradouro desta missão");
    expect(text).toContain("use workspace só para algo que vale no projeto todo");
    expect(text).toContain("só entra na busca após aprovação");
    expect(text).toContain("Handoff Structured");
    // Vem depois das instruções de coordenação.
    expect(text.indexOf("AO TERMINAR")).toBeGreaterThan(text.indexOf("COMO COORDENAR"));
  });
  it("sem id da missão não há o que sugerir", () => {
    expect(leadBriefing({ title: "T", objective: "O" }, [])).not.toContain("memory suggest");
  });
});
