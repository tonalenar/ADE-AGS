import { describe, expect, it } from "vitest";

import type { ForgeItem } from "@/features/forge/types";
import type { Task } from "@/features/runs/types";

import { backgroundTasks, branchPulls, folderLabel, formatElapsed, shortTokens } from "../panelModel";

const pr = (number: number, patch: Partial<ForgeItem> = {}): ForgeItem => ({
  number, title: `PR ${number}`, state: "open", draft: false, author: null, webUrl: "", createdAt: null,
  updatedAt: `2026-10-${String(number).padStart(2, "0")}`, comments: null, labels: [], sourceBranch: "feat/x", targetBranch: "dev",
  ...patch,
});

const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id, runId: "r", title: id, prompt: "", agentId: "codex", accountId: null, model: null, cwd: "C:\\repo", budgetUsd: null,
  status: "running", sessionId: null, attempt: 1, result: null, error: null, costUsd: null, tokensIn: null, tokensOut: null,
  eventsPath: null, worktreePath: null, branch: null, worktreeRemoved: false, complexity: null, routedBy: null,
  startedAt: 1000, endedAt: null, createdAt: 900,
  ...patch,
} as Task);

describe("folderLabel", () => {
  it("encurta o home com ~, como o Claude Code", () => {
    expect(folderLabel("C:\\Users\\eu\\.antigravity\\ADE-AGS", "C:\\Users\\eu")).toEqual({ name: "ADE-AGS", parent: "~\\.antigravity" });
    expect(folderLabel("C:\\Users\\eu\\proj", "c:\\users\\eu\\")).toEqual({ name: "proj", parent: "~" });
    // cwd com `/` e home com `\`, como vem do sistema no Windows.
    expect(folderLabel("C:/Users/eu/.antigravity/ADE-AGS", "C:\\Users\\eu")).toEqual({ name: "ADE-AGS", parent: "~/.antigravity" });
  });

  it("fora do home mostra o caminho do pai inteiro", () => {
    expect(folderLabel("/srv/app/web", "/home/eu")).toEqual({ name: "web", parent: "/srv/app" });
    expect(folderLabel("D:\\obra\\site", null)).toEqual({ name: "site", parent: "D:\\obra" });
  });
});

describe("branchPulls", () => {
  it("só os PRs que saem da branch, abertos primeiro e os mais novos antes", () => {
    const items = [pr(1, { state: "merged" }), pr(2, { sourceBranch: "outra" }), pr(3), pr(4)];
    expect(branchPulls(items, "feat/x").map((p) => p.number)).toEqual([4, 3, 1]);
  });

  it("sem branch (HEAD destacado) não mostra nada", () => {
    expect(branchPulls([pr(1)], null)).toEqual([]);
  });
});

describe("backgroundTasks", () => {
  it("separa as vivas desta pasta (e dos worktrees dentro dela) e conta as que acabaram", () => {
    const tasks = [
      task("a"), task("b", { status: "pending", startedAt: null, createdAt: 500 }),
      task("c", { status: "done" }), task("d", { cwd: "C:\\outro" }),
      task("e", { cwd: "C:/repo/.wt/x", status: "failed" }),
    ];
    const bg = backgroundTasks(tasks, "C:\\repo\\");
    expect(bg.live.map((t) => t.id)).toEqual(["b", "a"]);
    expect(bg.finished).toBe(2);
  });

  it("uma pasta com nome parecido não conta", () => {
    expect(backgroundTasks([task("a", { cwd: "C:\\repo-2" })], "C:\\repo").live).toEqual([]);
  });
});

describe("rótulos", () => {
  it("formatElapsed", () => {
    expect(formatElapsed(45_000)).toBe("45 s");
    expect(formatElapsed(168_000)).toBe("2 min 48 s");
    expect(formatElapsed(3_900_000)).toBe("1 h 05 min");
    expect(formatElapsed(-5)).toBe("0 s");
  });

  it("shortTokens", () => {
    expect(shortTokens(950, "en")).toBe("950");
    expect(shortTokens(12_340, "en")).toBe("12.3k");
    expect(shortTokens(1_000_000, "en")).toBe("1M");
  });
});
