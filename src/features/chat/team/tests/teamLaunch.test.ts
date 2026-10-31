// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ log: [] as string[], failLink: false, team: null as unknown }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("i18next", () => ({ default: { t: (key: string, o?: { defaultValue?: string }) => o?.defaultValue ?? key } }));
vi.mock("../../chatActions", () => ({
  startConversation: (input: { prompt: string; background?: boolean; title?: string }) => { calls.log.push(`aba ${input.title} prompt="${input.prompt}" background=${input.background}`); return Promise.resolve("tab-lead"); },
  openConversation: (ref: string) => calls.log.push(`mostra ${ref}`),
}));
vi.mock("../../structured/store", () => ({
  createThread: () => { calls.log.push("conversa por protocolo"); return Promise.resolve("th1"); },
  openThread: (id: string) => calls.log.push(`mostra thread:${id}`),
  settleThread: (id: string, settled: boolean) => calls.log.push(`conclui ${id} ${settled}`),
  useStructured: { getState: () => ({ threads: [] }) },
}));
vi.mock("../teamStore", () => ({
  useTeamStore: { getState: () => ({ teams: calls.team ? [calls.team] : [] }) },
  makeOrchestrator: (conv: { key: string }) => { calls.log.push(`time ${conv.key}`); return Promise.resolve({ id: "t1" }); },
  dissolveTeam: (id: string) => { calls.log.push(`dissolve ${id}`); return Promise.resolve(); },
  linkExisting: (_t: string, conv: { key: string }) => { calls.log.push(`liga ${conv.key}`); return Promise.resolve(); },
  unlinkMember: (_t: string, ref: string) => { calls.log.push(`desliga ${ref}`); return Promise.resolve(); },
  spawnMember: (input: { role: string }) => {
    calls.log.push(`abre integrante ${input.role}`);
    return Promise.resolve({ ref: "tab-m", label: "x", place: { cwd: "/wt", branch: "team/tests", root: "/wt" }, close: () => calls.log.push("fecha tab-m") });
  },
  linkSpawned: () => (calls.failLink ? Promise.reject(new Error("link falhou")) : Promise.resolve()),
  markTold: (id: string) => calls.log.push(`avisado ${id}`),
  sendToMember: (ref: string, text: string) => calls.log.push(`envia ${ref}: ${text}`),
  setComposerTarget: (ref: string, target: string) => calls.log.push(`destino ${ref} ${target}`),
}));

import { useTabsStore } from "@/features/tabs/store";
import { appTeamPort, type LeadSpec } from "../teamLaunch";
import type { DraftMember } from "../teamDraft";
import type { TeamView } from "../ipc";

const spec = (over: Partial<LeadSpec> = {}): LeadSpec => ({
  agent: { id: "claude-code", label: "Claude Code", command: "claude", available: true } as never, cwd: "/repo", title: "Montar o painel", model: null, effort: null,
  access: "ask", plan: false, accountId: null, account: undefined, viaProtocol: false, ...over,
});
const member: DraftMember = { id: "d1", kind: "new", agent: { id: "codex", label: "Codex", command: "codex", available: true } as never, role: "qa", policy: "read", subagent: false, model: null, effort: null, worktree: true };
const TEAM = {
  id: "t1", orchestrator: "tab-lead", agentId: "claude-code", label: "Claude Code", cwd: "/repo", title: "", createdAt: 1, updatedAt: 1, headcount: 2,
  members: [{ teamId: "t1", member: "tab-m", agentId: "codex", label: "Codex · Testes", role: "qa", model: null, policy: "read", branch: "team/tests", worktree: null, origin: "new", position: 0, createdAt: 1, updatedAt: 1, subagent: false }],
} as unknown as TeamView;

beforeEach(() => { calls.log = []; calls.failLink = false; calls.team = TEAM; });

describe("o TeamPort de verdade", () => {
  it("a conversa orquestradora nasce em segundo plano e SEM a mensagem (o texto só sai no fim)", async () => {
    const lead = await appTeamPort(spec(), "oi", "team").createLead();
    expect(calls.log).toEqual(['aba Montar o painel prompt="" background=true']);
    const close = vi.spyOn(useTabsStore.getState(), "closeTab").mockImplementation(() => undefined);
    await lead.undo();
    expect(close).toHaveBeenCalledWith("tab-lead");
    close.mockRestore();
  });

  it("por protocolo cria a conversa sem abri-la, e desfazer a conclui", async () => {
    const lead = await appTeamPort(spec({ viaProtocol: true }), "oi", "team").createLead();
    expect(lead.ref).toBe("thread:th1");
    expect(calls.log).toEqual(["conversa por protocolo"]);
    await lead.undo();
    expect(calls.log[calls.log.length - 1]).toBe("conclui th1 true");
  });

  it("o integrante novo avisa que o worktree fica; se ligar falhar, a conversa fecha e o erro leva a nota", async () => {
    calls.failLink = true;
    const port = appTeamPort(spec(), "oi", "team");
    await expect(port.linkMember("t1", member)).rejects.toMatchObject({ message: "link falhou", keeps: "worktree team/tests (/wt)" });
    expect(calls.log).toEqual(["abre integrante qa", "fecha tab-m"]);
  });

  it("entrega: no modo Time leva o aviso de elenco ao orquestrador, marca como avisado e mostra a conversa", () => {
    appTeamPort(spec(), "monte o painel", "team").deliver({ ref: "tab-lead", undo: async () => undefined }, "t1");
    const sent = calls.log.find((l) => l.startsWith("envia"))!;
    expect(sent).toContain("envia tab-lead: [ADE AGS] Você é o orquestrador deste time");
    expect(sent).toContain("monte o painel");
    expect(calls.log).toContain("avisado t1");
    expect(calls.log.slice(-2)).toEqual(["destino tab-lead team", "mostra tab-lead"]);
  });

  it("entrega: 'Só o orquestrador' vai sem o aviso de elenco e com o pedido de não delegar", () => {
    appTeamPort(spec(), "responda você", "lead").deliver({ ref: "tab-lead", undo: async () => undefined }, "t1");
    const sent = calls.log.find((l) => l.startsWith("envia"))!;
    expect(sent).toContain("[Só o orquestrador]");
    expect(sent).not.toContain("[ADE AGS]");
    expect(calls.log).not.toContain("avisado t1");
  });

  it("entrega: uma conversa por protocolo é aberta pelo openThread", () => {
    appTeamPort(spec({ viaProtocol: true }), "oi", "team").deliver({ ref: "thread:th1", undo: async () => undefined }, "t1");
    expect(calls.log[calls.log.length - 1]).toBe("mostra thread:th1");
  });

  it("entrega: se o time não está na lista, falha antes de enviar qualquer coisa", () => {
    calls.team = null;
    expect(() => appTeamPort(spec(), "oi", "team").deliver({ ref: "tab-lead", undo: async () => undefined }, "t1")).toThrow();
    expect(calls.log.some((l) => l.startsWith("envia"))).toBe(false);
  });
});
