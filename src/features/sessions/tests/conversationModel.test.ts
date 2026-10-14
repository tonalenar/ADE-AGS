import { describe, expect, it } from "vitest";

import type { Tab } from "@/features/tabs/types";
import {
  CONV_SEP,
  activeAgentWork,
  conversationBoardKey,
  conversationIdOfKey,
  conversationTitle,
  firstToActivate,
  isConversationKey,
  parseConversationSnapshot,
  parseTerminals,
  pickRestoreOrder,
  snapshotConversation,
  snapshotTerminals,
  type ConversationRow,
  type TerminalSnapshot,
} from "@/features/sessions/conversationModel";

function tab(over: Partial<Tab> & { id: string }): Tab {
  return {
    title: "Claude",
    cwd: "C:/projeto",
    agentId: "claude",
    agentLabel: "Claude",
    command: "claude",
    ptyId: null,
    openedAt: 0,
    ...over,
  };
}

function terminal(over: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return {
    agentId: "claude",
    agentLabel: "Claude",
    command: "claude",
    title: "Claude",
    titleIsCustom: false,
    sessionId: null,
    accountId: null,
    prelaunch: [],
    skillIds: [],
    box: null,
    role: null,
    orchestrator: false,
    ...over,
  };
}

function row(over: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: "c1",
    workspaceId: "default",
    projectKey: "k",
    cwd: "C:/projeto",
    title: null,
    customTitle: null,
    pinned: false,
    hidden: false,
    state: "saved",
    terminals: [],
    createdAt: 0,
    lastActiveAt: 0,
    ...over,
  };
}

const noSkills = () => [] as string[];

describe("chaves do canvas", () => {
  it("conversationBoardKey junta base, separador e id", () => {
    expect(CONV_SEP).toBe("#c:");
    expect(conversationBoardKey("win|C:/p", "abc")).toBe("win|C:/p#c:abc");
  });

  it("conversationIdOfKey devolve o id, ou null", () => {
    expect(conversationIdOfKey("win|C:/p#c:abc")).toBe("abc");
    expect(conversationIdOfKey("win|C:/p#m:m1#c:abc")).toBe("abc");
    expect(conversationIdOfKey("win|C:/p")).toBeNull();
    expect(conversationIdOfKey("win|C:/p#c:")).toBeNull();
    expect(conversationIdOfKey(null)).toBeNull();
  });

  it("isConversationKey diz se a chave é de conversa", () => {
    expect(isConversationKey("win|C:/p#c:abc")).toBe(true);
    expect(isConversationKey("win|C:/p#m:m1")).toBe(false);
    expect(isConversationKey("win|C:/p#c:")).toBe(false);
    expect(isConversationKey(null)).toBe(false);
  });

  it("a chave de conversa tem id reconhecível de volta", () => {
    expect(conversationIdOfKey(conversationBoardKey("base", "x-1"))).toBe("x-1");
  });
});

describe("snapshotTerminals", () => {
  it("exclui a shell e mantém a ordem recebida", () => {
    const tabs = [
      tab({ id: "a", agentId: "claude" }),
      tab({ id: "s", agentId: "bash", agentLabel: "Shell", command: "bash" }),
      tab({ id: "b", agentId: "codex", agentLabel: "Codex", command: "codex" }),
    ];
    const snap = snapshotTerminals(tabs, {}, noSkills);
    expect(snap.map((t) => t.agentId)).toEqual(["claude", "codex"]);
  });

  it("copia box, skills, papel e coroa", () => {
    const tabs = [tab({ id: "a", sessionId: "sess", accountId: "acc", prelaunch: [{ command: "echo oi" }], titleIsCustom: true })];
    const nodes = { a: { x: 1, y: 2, w: 3, h: 4 } };
    const snap = snapshotTerminals(tabs, nodes, (id) => (id === "a" ? ["skill-1"] : []), { a: "dev" }, ["a"]);
    expect(snap).toEqual([
      {
        agentId: "claude",
        agentLabel: "Claude",
        command: "claude",
        title: "Claude",
        titleIsCustom: true,
        sessionId: "sess",
        accountId: "acc",
        prelaunch: [{ command: "echo oi" }],
        skillIds: ["skill-1"],
        box: { x: 1, y: 2, w: 3, h: 4 },
        role: "dev",
        orchestrator: true,
      },
    ]);
  });

  it("box ausente vira null e campos opcionais viram padrões", () => {
    const [t] = snapshotTerminals([tab({ id: "a" })], {}, noSkills);
    expect(t.box).toBeNull();
    expect(t.sessionId).toBeNull();
    expect(t.accountId).toBeNull();
    expect(t.role).toBeNull();
    expect(t.titleIsCustom).toBe(false);
    expect(t.orchestrator).toBe(false);
  });
});

describe("parseTerminals", () => {
  it("ignora itens sem agentId ou command string", () => {
    const out = parseTerminals([
      null,
      "lixo",
      42,
      { command: "x" },
      { agentId: "claude" },
      { agentId: 1, command: "x" },
      { agentId: "claude", command: "claude" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].agentId).toBe("claude");
  });

  it("não lança com entrada que não é lista", () => {
    expect(parseTerminals(null)).toEqual([]);
    expect(parseTerminals("x")).toEqual([]);
    expect(parseTerminals({ agentId: "a", command: "b" })).toEqual([]);
  });

  it("preenche padrões", () => {
    const [t] = parseTerminals([{ agentId: "codex", command: "codex" }]);
    expect(t).toEqual({
      agentId: "codex",
      agentLabel: "codex",
      command: "codex",
      title: "codex",
      titleIsCustom: false,
      sessionId: null,
      accountId: null,
      prelaunch: [],
      skillIds: [],
      box: null,
      role: null,
      orchestrator: false,
    });
  });

  it("limita a 24 terminais válidos", () => {
    const raw = Array.from({ length: 30 }, (_, i) => ({ agentId: "claude", command: `c${i}` }));
    const out = parseTerminals(raw);
    expect(out).toHaveLength(24);
    expect(out[23].command).toBe("c23");
  });

  it("o limite conta só os válidos", () => {
    const raw = [
      ...Array.from({ length: 10 }, () => ({ agentId: "" })),
      ...Array.from({ length: 30 }, (_, i) => ({ agentId: "claude", command: `c${i}` })),
    ];
    expect(parseTerminals(raw)).toHaveLength(24);
  });

  it("box só com x, y, w, h finitos", () => {
    const base = { agentId: "claude", command: "claude" };
    const [ok, nan, inf, missing, str, nul] = parseTerminals([
      { ...base, box: { x: 0, y: 1, w: 2, h: 3 } },
      { ...base, box: { x: NaN, y: 1, w: 2, h: 3 } },
      { ...base, box: { x: 0, y: Infinity, w: 2, h: 3 } },
      { ...base, box: { x: 0, y: 1, w: 2 } },
      { ...base, box: { x: "0", y: 1, w: 2, h: 3 } },
      { ...base, box: null },
    ]);
    expect(ok.box).toEqual({ x: 0, y: 1, w: 2, h: 3 });
    expect(nan.box).toBeNull();
    expect(inf.box).toBeNull();
    expect(missing.box).toBeNull();
    expect(str.box).toBeNull();
    expect(nul.box).toBeNull();
  });

  it("skillIds só strings e prelaunch só passos válidos", () => {
    const [t] = parseTerminals([
      {
        agentId: "claude",
        command: "claude",
        skillIds: ["a", 2, null, "b"],
        prelaunch: [{ presetId: "p1" }, { command: "ls" }, { nada: true }, "x"],
      },
    ]);
    expect(t.skillIds).toEqual(["a", "b"]);
    expect(t.prelaunch).toEqual([{ presetId: "p1" }, { command: "ls" }]);
  });

  it("orchestrator só é true quando literalmente true", () => {
    const [a, b] = parseTerminals([
      { agentId: "claude", command: "c", orchestrator: true },
      { agentId: "claude", command: "c", orchestrator: "true" },
    ]);
    expect(a.orchestrator).toBe(true);
    expect(b.orchestrator).toBe(false);
  });
});

describe("activeAgentWork", () => {
  it("devolve só as abas de agente que estão trabalhando", () => {
    const tabs = [
      tab({ id: "a" }),
      tab({ id: "b" }),
      tab({ id: "s", agentId: "bash" }),
    ];
    const working = new Set(["a", "s"]);
    expect(activeAgentWork(tabs, (id) => working.has(id)).map((t) => t.id)).toEqual(["a"]);
  });

  it("lista vazia quando ninguém trabalha", () => {
    expect(activeAgentWork([tab({ id: "a" })], () => false)).toEqual([]);
  });
});

describe("conversationTitle", () => {
  const terms = [terminal({ title: "Refatorar login" })];

  it("prefere o título personalizado, aparado", () => {
    expect(conversationTitle(row({ customTitle: "  Meu nome  ", title: "outro" }), terms)).toBe("Meu nome");
  });

  it("corta o título personalizado em 120", () => {
    const t = conversationTitle(row({ customTitle: "x".repeat(200) }), []);
    expect(Array.from(t)).toHaveLength(120);
    expect(t.endsWith("…")).toBe(true);
  });

  it("sem personalizado, usa o título aparado", () => {
    expect(conversationTitle(row({ customTitle: "   ", title: "  Sessão  " }), terms)).toBe("Sessão");
  });

  it("sem títulos, usa o primeiro terminal cortado em 60", () => {
    expect(conversationTitle(row(), terms)).toBe("Refatorar login");
    const longo = [terminal({ title: "y".repeat(100) })];
    expect(Array.from(conversationTitle(row(), longo))).toHaveLength(60);
  });

  it("nunca vazio", () => {
    expect(conversationTitle(row(), [])).toBe("Nova conversa");
    expect(conversationTitle(row({ customTitle: "  ", title: "" }), [terminal({ title: "  " })])).toBe("Nova conversa");
  });
});

describe("pickRestoreOrder e firstToActivate", () => {
  it("a coroa vai primeiro e o resto mantém a ordem", () => {
    const list = [
      terminal({ command: "a" }),
      terminal({ command: "b" }),
      terminal({ command: "c", orchestrator: true }),
      terminal({ command: "d" }),
    ];
    expect(pickRestoreOrder(list).map((t) => t.command)).toEqual(["c", "a", "b", "d"]);
  });

  it("sem coroa, a ordem não muda e é uma cópia", () => {
    const list = [terminal({ command: "a" }), terminal({ command: "b" })];
    const out = pickRestoreOrder(list);
    expect(out.map((t) => t.command)).toEqual(["a", "b"]);
    expect(out).not.toBe(list);
  });

  it("coroa já na frente não muda a ordem", () => {
    const list = [terminal({ command: "a", orchestrator: true }), terminal({ command: "b" })];
    expect(pickRestoreOrder(list).map((t) => t.command)).toEqual(["a", "b"]);
  });

  it("lista vazia", () => {
    expect(pickRestoreOrder([])).toEqual([]);
  });

  it("firstToActivate é 0 com terminais e -1 vazio", () => {
    expect(firstToActivate([terminal()])).toBe(0);
    expect(firstToActivate([])).toBe(-1);
  });
});

describe("snapshotConversation", () => {
  it("monta terminais e conexões como pares de índices a<b", () => {
    const tabs = [
      tab({ id: "a" }),
      tab({ id: "s", agentId: "bash" }),
      tab({ id: "b", agentId: "codex", command: "codex" }),
      tab({ id: "c" }),
    ];
    const snap = snapshotConversation(
      tabs,
      { a: { x: 0, y: 0, w: 1, h: 1 } },
      noSkills,
      {},
      [
        { a: "c", b: "a" },
        { a: "a", b: "b" },
        { a: "a", b: "s" }, // a shell não é terminal do snapshot
        { a: "a", b: "zzz" }, // nó desconhecido
        { a: "b", b: "a" }, // repetida
        { a: "c", b: "c" }, // laço
      ],
      ["b"],
    );
    expect(snap.terminals.map((t) => t.command)).toEqual(["claude", "codex", "claude"]);
    expect(snap.terminals[1].orchestrator).toBe(true);
    expect(snap.links).toEqual([
      [0, 2],
      [0, 1],
    ]);
  });

  it("sem conexões, links vazio", () => {
    expect(snapshotConversation([tab({ id: "a" })], {}, noSkills, {}, [], []).links).toEqual([]);
  });
});

describe("parseConversationSnapshot", () => {
  it("aceita o formato antigo (array puro) e devolve links vazios", () => {
    const snap = parseConversationSnapshot([{ agentId: "claude", command: "claude" }]);
    expect(snap.terminals).toHaveLength(1);
    expect(snap.links).toEqual([]);
  });

  it("lê o formato novo", () => {
    const snap = parseConversationSnapshot({
      terminals: [{ agentId: "claude", command: "a" }, { agentId: "codex", command: "b" }],
      links: [[0, 1]],
    });
    expect(snap.terminals.map((t) => t.command)).toEqual(["a", "b"]);
    expect(snap.links).toEqual([[0, 1]]);
  });

  it("não lança com lixo", () => {
    expect(parseConversationSnapshot(null)).toEqual({ terminals: [], links: [] });
    expect(parseConversationSnapshot("x")).toEqual({ terminals: [], links: [] });
    expect(parseConversationSnapshot({ terminals: "x", links: "y" })).toEqual({ terminals: [], links: [] });
  });

  it("valida os links: índices inteiros dentro do intervalo, a != b, sem repetição, a<b", () => {
    const terms = [
      { agentId: "claude", command: "a" },
      { agentId: "claude", command: "b" },
      { agentId: "claude", command: "c" },
    ];
    const snap = parseConversationSnapshot({
      terminals: terms,
      links: [
        [2, 0], // invertido: vira [0, 2]
        [0, 2], // repetida
        [1, 1], // laço
        [0, 3], // fora do intervalo
        [-1, 1], // negativo
        [0.5, 1], // não inteiro
        ["0", 1], // não número
        [1], // tamanho errado
        "0-1", // não é par
        [1, 2],
      ],
    });
    expect(snap.links).toEqual([
      [0, 2],
      [1, 2],
    ]);
  });

  it("limita os links a 64", () => {
    const terminals = Array.from({ length: 24 }, (_, i) => ({ agentId: "claude", command: `c${i}` }));
    const links: [number, number][] = [];
    for (let i = 0; i < 24; i++) for (let j = i + 1; j < 24; j++) links.push([i, j]);
    expect(links.length).toBeGreaterThan(64);
    const snap = parseConversationSnapshot({ terminals, links });
    expect(snap.terminals).toHaveLength(24);
    expect(snap.links).toHaveLength(64);
    expect(snap.links[0]).toEqual([0, 1]);
  });

  it("descarta links que apontam para terminais que foram descartados", () => {
    const snap = parseConversationSnapshot({
      terminals: [{ agentId: "claude", command: "a" }, { agentId: "", command: "x" }],
      links: [[0, 1]],
    });
    expect(snap.terminals).toHaveLength(1);
    expect(snap.links).toEqual([]);
  });

  it("ida e volta do snapshotConversation", () => {
    const tabs = [tab({ id: "a", command: "a" }), tab({ id: "b", command: "b" })];
    const saved = snapshotConversation(tabs, {}, noSkills, {}, [{ a: "a", b: "b" }], ["a"]);
    const back = parseConversationSnapshot(JSON.parse(JSON.stringify(saved)));
    expect(back).toEqual(saved);
    expect(back.terminals[0].orchestrator).toBe(true);
  });
});
