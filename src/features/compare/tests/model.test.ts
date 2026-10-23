import { describe, expect, it } from "vitest";

import {
  becameIdle, changeSummary, defaultTitle, diffLines, draftProblem, entryState, hardBlocked, pickLabel, pickSlug, picksToRemove,
  promptFor, riskyRemovals, slugPart, uniquePicks,
} from "../model";
import type { PickDraft, RemoveEntry } from "../types";

const draft = (agentId: string, model: string | null = null, effort: string | null = null, fast = false): PickDraft => ({ agentId, model, effort, fast });
/** Mesmas regras de `valid_pick` em `src-tauri/src/compare/model.rs`. */
const validPick = (p: string) => /^[a-z0-9](?:[a-z0-9.-]{0,46}[a-z0-9])?$/.test(p) && !p.includes("..") && !p.endsWith(".lock");

describe("nomes de branch da comparação", () => {
  it("o pick junta agente curto, modelo, esforço e Fast", () => {
    expect(pickSlug(draft("claude-code", "opus", "high"))).toBe("claude-opus-high");
    expect(pickSlug(draft("codex", "gpt-5.1", null, true))).toBe("codex-gpt-5.1-fast");
    expect(pickSlug(draft("opencode", "openai/gpt-4.1-mini"))).toBe("opencode-openai-gpt-4.1-mini");
    expect(pickSlug(draft("gemini-cli"))).toBe("gemini");
  });

  it("todo pick vale como pedaço de ref do git, mesmo com lixo no modelo", () => {
    const nasty = ["..", "Ação Ñ", "a..b", "-x-", "x.lock", "///", "a".repeat(90), "modelo com espaço."];
    for (const model of nasty) expect(validPick(pickSlug(draft("kimi-code", model))), model).toBe(true);
    expect(slugPart("  ..Olá..mundo.. ")).toBe("ola.mundo");
  });

  it("nomes repetidos ganham sufixo", () => {
    expect(uniquePicks(["claude", "codex", "claude", "claude"])).toEqual(["claude", "codex", "claude-2", "claude-3"]);
  });

  it("o rótulo mostra o que foi escolhido", () => {
    expect(pickLabel(draft("codex", "gpt-5.1", "high", true), "Codex")).toBe("Codex · gpt-5.1 · high · Fast");
    expect(pickLabel(draft("claude-code"), "Claude Code")).toBe("Claude Code");
  });

  it("o título padrão é a primeira linha, curta", () => {
    expect(defaultTitle("\n  Corrigir o login quando o token expira e mais coisas\nsegunda linha")).toBe("Corrigir o login quando o token");
    expect(defaultTitle("x".repeat(80)).length).toBe(48);
    expect(defaultTitle("")).toBe("");
  });
});

describe("validação do diálogo", () => {
  const base = { prompt: "faça", picks: [draft("claude-code"), draft("codex")], isolate: true, isRepo: true, available: ["claude-code", "codex"] };
  it("aceita um formulário completo", () => expect(draftProblem(base)).toBeNull());
  it("aponta o primeiro problema", () => {
    expect(draftProblem({ ...base, prompt: "  " })).toBe("compare.error.prompt");
    expect(draftProblem({ ...base, picks: [draft("codex")] })).toBe("compare.error.few");
    expect(draftProblem({ ...base, picks: Array.from({ length: 7 }, (_, i) => draft("codex", `m${i}`)) })).toBe("compare.error.many");
    expect(draftProblem({ ...base, picks: [draft(""), draft("codex")] })).toBe("compare.error.agent");
    expect(draftProblem({ ...base, picks: [draft("gemini-cli"), draft("codex")] })).toBe("compare.error.unavailable");
    expect(draftProblem({ ...base, picks: [draft("codex", "x"), draft("codex", "x")] })).toBe("compare.error.duplicate");
    expect(draftProblem({ ...base, isRepo: false })).toBe("compare.error.repo");
  });
  it("sem isolamento não exige repositório", () => expect(draftProblem({ ...base, isolate: false, isRepo: false })).toBeNull());
});

describe("o pedido de cada agente", () => {
  const isolated = { cwd: "C:/wt/ab12", branch: "cmp/login-abc123/codex", root: "C:/wt/ab12" };
  it("Claude Code recebe as quebras de linha e o worktree", () => {
    const text = promptFor("claude-code", "linha 1\nlinha 2", isolated);
    expect(text).toContain("C:/wt/ab12");
    expect(text).toContain("cmp/login-abc123/codex");
    expect(text.endsWith("linha 1\nlinha 2")).toBe(true);
  });
  it("as outras TUIs recebem uma linha só, com o mesmo pedido", () => {
    const text = promptFor("codex", "linha 1\n\n- item", isolated);
    expect(text).not.toContain("\n");
    expect(text).toContain("linha 1 | - item");
  });
  it("sem isolamento o pedido avisa que é só leitura", () => {
    expect(promptFor("claude-code", "x", { cwd: "C:/p", branch: null, root: null })).toContain("só de leitura");
  });
});

describe("estado dos terminais", () => {
  it("fechado, iniciando, trabalhando e parado", () => {
    expect(entryState({ tabOpen: false, pending: true, active: true })).toBe("closed");
    expect(entryState({ tabOpen: true, pending: true, active: true })).toBe("starting");
    expect(entryState({ tabOpen: true, pending: false, active: true })).toBe("working");
    expect(entryState({ tabOpen: true, pending: false, active: false })).toBe("idle");
  });
  it("mede de novo só quando alguém para ou fecha", () => {
    expect(becameIdle({ a: "working", b: "idle" }, { a: "idle", b: "idle" })).toBe(true);
    expect(becameIdle({ a: "working" }, { a: "closed" })).toBe(true);
    expect(becameIdle({ a: "idle" }, { a: "working" })).toBe(false);
    expect(becameIdle({}, { a: "idle" })).toBe(false);
  });
  it("o resumo das mudanças", () => {
    const t = (key: string, o?: Record<string, unknown>) => `${key}:${o?.count}`;
    const status = { pick: "a", files: 3, insertions: 12, deletions: 4, untracked: 1, commits: 1, dirty: true, error: null };
    expect(changeSummary(status, t)).toBe("compare.changes.files:3 · +12 −4 · compare.changes.commits:1");
    expect(changeSummary({ ...status, insertions: 0, deletions: 0, commits: 0 }, t)).toBe("compare.changes.files:3");
    expect(changeSummary({ ...status, error: "x" }, t)).toBeNull();
    expect(changeSummary(undefined, t)).toBeNull();
  });
});

describe("limpeza", () => {
  const entry = (pick: string, patch: Partial<RemoveEntry> = {}): RemoveEntry => ({
    pick, removed: false, blockers: [], dirty: [], commits: [], savedRef: null, branchKept: false, needsConfirmation: false, ...patch,
  });
  it("sai todo mundo menos o mantido", () => {
    expect(picksToRemove([{ pick: "a" }, { pick: "b" }, { pick: "c" }], "b")).toEqual(["a", "c"]);
    expect(picksToRemove([{ pick: "a" }, { pick: "b" }], null)).toEqual(["a", "b"]);
  });
  it("separa o que pede confirmação do que é trava dura", () => {
    const report = [
      entry("a", { dirty: ["x.ts"], needsConfirmation: true, blockers: ["confirme"] }),
      entry("b"),
      entry("c", { blockers: ["worktree fora da pasta"] }),
    ];
    expect(riskyRemovals(report).map((e) => e.pick)).toEqual(["a"]);
    expect(hardBlocked(report).map((e) => e.pick)).toEqual(["c"]);
  });
  it("pinta as linhas do diff", () => {
    expect(diffLines("diff --git a b\n@@ -1 +1 @@\n-velho\n+novo\n ctx").map((l) => l.kind)).toEqual(["meta", "hunk", "del", "add", "ctx"]);
  });
});
