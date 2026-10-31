import { describe, expect, it } from "vitest";

import {
  activityPhrase, commandPhrase, formatElapsed, formatTokens, openTurnItems, planProgress, shouldFlushQueue, snapshotActivity, toolKindOfName, turnLive,
} from "@/features/chat/activityModel";
import { timelineTurns } from "@/features/chat/timeline/timelineModel";
import type { TimelineItem } from "@/features/chat/timeline/types";

const user = (id: string, at: number): TimelineItem => ({ kind: "user", id, at, text: "faz" });
const tool = (id: string, extra: Partial<TimelineItem>): TimelineItem => ({ kind: "tool", id, tool: "command", status: "done", ...extra });

describe("linha viva do turno", () => {
  const items: TimelineItem[] = [
    user("u0", 10),
    { kind: "turnEnd", id: "e0", durationMs: 5 },
    user("u1", 1_000),
    { kind: "usage", id: "usage:m1", tokens: 50_000 },
    { kind: "reasoning", id: "r1", text: "conferir o snap de 8 px" },
    tool("t1", { label: "bunx tsc --noEmit", status: "done" }),
    { kind: "usage", id: "usage:m2", tokens: 38_600 },
    tool("t2", { label: "bun x tauri build --debug", status: "running" }),
  ];

  it("só olha o turno em aberto", () => {
    expect(openTurnItems(items)[0]!.id).toBe("u1");
    expect(openTurnItems([...items, { kind: "turnEnd", id: "e1" }])).toEqual([]);
  });

  it("a atividade é a ferramenta rodando; soma os tokens; guarda o raciocínio e os últimos comandos", () => {
    const live = turnLive(items);
    expect(live.startedAt).toBe(1_000);
    expect(live.tokens).toBe(88_600);
    expect(live.activity).toEqual({ kind: "tool", tool: "command", target: "bun x tauri build --debug" });
    expect(live.reasoning).toBe("conferir o snap de 8 px");
    expect(live.recent.map((r) => [r.label, r.status])).toEqual([["bunx tsc --noEmit", "done"], ["bun x tauri build --debug", "running"]]);
  });

  it("sem ferramenta rodando, pensando; com pedido, esperando; sem usage, sem tokens", () => {
    expect(turnLive([user("u", 1)]).activity).toEqual({ kind: "thinking" });
    expect(turnLive([user("u", 1)]).tokens).toBeNull();
    expect(turnLive(items, true).activity).toEqual({ kind: "waiting" });
  });

  it("o raciocínio e os tokens não entram no fio da conversa", () => {
    const turns = timelineTurns(items);
    expect(turns).toHaveLength(2);
    expect(turns[1]!.body.flatMap((r) => (r.type === "work" ? r.tools.map((t) => t.id) : [r.key]))).toEqual(["t1", "t2"]);
  });

  it("o turno guarda o último plano publicado", () => {
    const plan = [{ text: "Ler", status: "completed" as const }, { text: "Testar", status: "inProgress" as const }];
    const turns = timelineTurns([user("u", 1), tool("p", { tool: "todo", label: "2", plan })]);
    expect(turns[0]!.plan).toEqual(plan);
  });
});

describe("frases da atividade", () => {
  it("comandos conhecidos têm nome próprio", () => {
    expect(commandPhrase("bun run test")).toBe("chat.live.tests");
    expect(commandPhrase("cd src-tauri && cargo test --lib")).toBe("chat.live.tests");
    expect(commandPhrase("bunx tsc --noEmit")).toBe("chat.live.typecheck");
    expect(commandPhrase("bun add @codemirror/lang-html")).toBe("chat.live.install");
    expect(commandPhrase("git status")).toBe("chat.live.git");
    expect(commandPhrase("ls -la")).toBeNull();
  });

  it("a chave e o alvo de cada atividade", () => {
    expect(activityPhrase({ kind: "thinking" })).toEqual({ key: "chat.live.thinking" });
    expect(activityPhrase({ kind: "tool", tool: "command", target: "ls -la" })).toEqual({ key: "chat.live.command", target: "ls -la" });
    expect(activityPhrase({ kind: "tool", tool: "edit", target: "frameBridge.ts" })).toEqual({ key: "chat.live.edit", target: "frameBridge.ts" });
    expect(activityPhrase({ kind: "tool", tool: "todo", target: "3" })).toEqual({ key: "chat.live.todo" });
  });

  it("o canal da TUI vira atividade pelo nome da ferramenta", () => {
    expect(toolKindOfName("Bash")).toBe("command");
    expect(toolKindOfName("apply_patch")).toBe("edit");
    expect(toolKindOfName("qualquer")).toBe("other");
    expect(snapshotActivity([{ name: "Edit", summary: "/p/src/a.ts" }])).toEqual({ kind: "tool", tool: "edit", target: "a.ts" });
    expect(snapshotActivity([])).toEqual({ kind: "thinking" });
    expect(snapshotActivity([{ name: "Bash", summary: "ls" }], true)).toEqual({ kind: "waiting" });
  });
});

describe("tempo, tokens e plano", () => {
  it("o tempo como a prancheta escreve", () => {
    expect(formatElapsed(52_400)).toBe("52 s");
    expect(formatElapsed(72_000)).toBe("1 min 12 s");
    expect(formatElapsed(120_000)).toBe("2 min");
    expect(formatElapsed(3_780_000)).toBe("1 h 3 min");
    expect(formatElapsed(-5)).toBe("0 s");
  });

  it("os tokens curtos no idioma", () => {
    // O Intl separa o número da unidade com um espaço que não quebra.
    expect(formatTokens(88_600, "pt-BR").replace(/\s/g, " ")).toBe("88,6 mil");
    expect(formatTokens(88_600, "en")).toBe("88.6K");
  });

  it("o andamento do plano: concluídos, total e o passo atual", () => {
    const plan = [
      { text: "a", status: "completed" as const }, { text: "b", status: "completed" as const },
      { text: "c", status: "inProgress" as const }, { text: "d", status: "pending" as const },
    ];
    expect(planProgress(plan)).toEqual({ done: 2, total: 4, current: 2 });
    expect(planProgress(plan.map((s) => (s.status === "inProgress" ? { ...s, status: "pending" as const } : s))).current).toBe(2);
    expect(planProgress([{ text: "a", status: "completed" }]).current).toBe(-1);
  });
});

describe("fila do composer", () => {
  it("esvazia uma por vez quando o turno acaba, e nunca com um pedido esperando", () => {
    expect(shouldFlushQueue(true, false, false, 1)).toBe(true);
    expect(shouldFlushQueue(true, true, false, 1)).toBe(false);
    expect(shouldFlushQueue(false, false, false, 1)).toBe(false);
    expect(shouldFlushQueue(undefined, false, false, 1)).toBe(false);
    expect(shouldFlushQueue(true, false, true, 2)).toBe(false);
    expect(shouldFlushQueue(true, false, false, 0)).toBe(false);
  });
});
