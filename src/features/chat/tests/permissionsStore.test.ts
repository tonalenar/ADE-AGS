import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/invokeMock").then((m) => m.tauriCoreMock()));

import { invokeMock, useInvokeMock } from "@/test/invokeMock";
import { autoAllowRule, type PendingAsk } from "@/features/chat/permissions/permissionModel";
import { alwaysAllow, answerAsk, loadRules, usePermissions } from "@/features/chat/permissions/permissionsStore";
import { useStructured } from "@/features/chat/structured/store";

useInvokeMock();

const threadAsk: PendingAsk = {
  id: "thread:q",
  ref: { source: "thread", threadId: "th", requestId: "q" },
  agentId: "codex",
  agentLabel: "Codex",
  conversation: "thread:th",
  where: "Chat",
  kind: "command",
  detail: "bun add zod",
  files: [],
  network: false,
  cwd: "/repo",
  risk: "medium",
  canSession: true,
  atMs: 0,
};

const highAsk: PendingAsk = { ...threadAsk, id: "thread:push", ref: { source: "thread", threadId: "th", requestId: "p" }, detail: "git push origin x", risk: "high" };

beforeEach(() => {
  usePermissions.setState({ rules: [], rulesLoaded: false, inboxOpen: false, filter: "all", selected: "thread:q", tui: [], answered: {} });
  useStructured.setState({ live: { th: { requests: [{ id: "q" }, { id: "p" }] } } } as never);
});

describe("o store real de permissão", () => {
  it("allow e deny mandam o threadId e o requestId ao backend e fecham o cartão", async () => {
    invokeMock.on("chat_request_answer", true);
    answerAsk(threadAsk, "allow");
    expect(invokeMock.calls("chat_request_answer")).toEqual([{ requestId: "q", choice: "allow" }]);
    expect(usePermissions.getState().answered["thread:q"]).toBe(true);
    expect(usePermissions.getState().selected).toBeNull();
    expect(useStructured.getState().live.th?.requests.some((r) => r.id === "q")).toBe(false);

    answerAsk({ ...threadAsk, id: "thread:d", ref: { source: "thread", threadId: "th", requestId: "d" } }, "deny");
    const answers = invokeMock.calls("chat_request_answer") as Array<{ requestId: string; choice: string }>;
    expect(answers[answers.length - 1]).toEqual({ requestId: "d", choice: "deny" });
  });

  it("Responder… nega e manda o texto ao fio", async () => {
    invokeMock.on("chat_request_answer", true);
    invokeMock.on("chat_thread_send", true);
    answerAsk(threadAsk, "deny", "use o pnpm");
    expect(invokeMock.calls("chat_request_answer")).toEqual([{ requestId: "q", choice: "deny" }]);
    expect(invokeMock.calls("chat_thread_send")[0]).toMatchObject({ threadId: "th", text: "use o pnpm" });
  });

  it("Sempre permitir grava a regra e permite; risco alto não entra no auto-allow", async () => {
    invokeMock.on("chat_permission_rules", [{ id: "r1", kind: "command", pattern: "bun add *", agentId: "codex", role: null, teamId: null, createdAt: 1 }]);
    invokeMock.on("chat_request_answer", true);
    let resolveAdd!: () => void;
    const added = new Promise<void>((resolve) => { resolveAdd = resolve; });
    invokeMock.on("chat_permission_rule_add", () => {
      resolveAdd();
      return { id: "r1", kind: "command", pattern: "bun add *", agentId: "codex", role: null, teamId: null, createdAt: 1 };
    });
    alwaysAllow(threadAsk, "bun add *");
    await added;
    expect(invokeMock.calls("chat_permission_rule_add").length).toBeGreaterThan(0);
    await loadRules();
    const rules = usePermissions.getState().rules;
    expect(rules).toEqual([expect.objectContaining({ pattern: "bun add *", agentId: "codex" })]);
    expect(autoAllowRule(rules, threadAsk)?.pattern).toBe("bun add *");
    expect(autoAllowRule(rules, highAsk)).toBeNull();
    expect(invokeMock.calls("chat_request_answer")).toEqual([{ requestId: "q", choice: "allow" }]);
  });
});
