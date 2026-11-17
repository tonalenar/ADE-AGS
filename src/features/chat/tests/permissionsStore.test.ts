import { beforeEach, describe, expect, it, vi } from "vitest";

// A store fala com o IPC de regras, com a resposta de cada fonte de pedido e com o aviso do sistema. Os
// módulos pesados (terminal, canvas, conversa) ficam de fora: o teste só cobra a regra de "sair da tela".
const mocks = vi.hoisted(() => ({
  rules: vi.fn(),
  ruleAdd: vi.fn(),
  ruleUpdate: vi.fn(),
  ruleRemove: vi.fn(),
  alerta: vi.fn(() => Promise.resolve({})),
  answerRequest: vi.fn(),
  answerTerminalPrompt: vi.fn(),
  decideApproval: vi.fn(),
}));

vi.mock("@/features/chat/permissions/ipc", () => ({
  chatPermissionRules: mocks.rules,
  chatPermissionRuleAdd: mocks.ruleAdd,
  chatPermissionRuleUpdate: mocks.ruleUpdate,
  chatPermissionRuleRemove: mocks.ruleRemove,
  ruleOf: (row: unknown) => row,
}));
vi.mock("@/shared/ui/alerts", () => ({ AlertaToast: mocks.alerta }));
vi.mock("@/features/canvas/useTerminalPrompts", () => ({ answerTerminalPrompt: mocks.answerTerminalPrompt }));
vi.mock("@/features/runs/store", () => ({ useRunsStore: { getState: () => ({ decideApproval: mocks.decideApproval }) } }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/features/tabs/store", () => ({ useTabsStore: () => [] }));
vi.mock("@/features/chat/chatActions", () => ({ sendToConversation: vi.fn() }));
vi.mock("@/features/chat/ipc", () => ({ chatPermissionNotify: vi.fn(() => Promise.resolve()) }));
vi.mock("@/features/chat/liveStore", () => ({ useChatLive: () => undefined }));
vi.mock("@/features/chat/shelf", () => ({ unsnoozeConversation: vi.fn() }));
vi.mock("@/features/chat/structured/store", () => ({
  answerRequest: mocks.answerRequest,
  sendToThread: vi.fn(),
  useStructured: () => [],
  hydrateThread: vi.fn(),
}));
vi.mock("@/features/chat/team/teamPermissions", () => ({ teamVerdictForAsk: () => null }));
vi.mock("@/features/chat/team/teamStore", () => ({ useTeamStore: { getState: () => ({ teams: [] }) } }));

import { usePermissions, answerAsk, loadRules, removeRule, updateRule } from "@/features/chat/permissions/permissionsStore";
import type { PendingAsk } from "@/features/chat/permissions/permissionModel";

const rule = { id: "r1", kind: "command" as const, pattern: "bun *", agentId: null, createdAt: 1 };

const base: Omit<PendingAsk, "id" | "ref"> = {
  agentId: "claude-code", agentLabel: "Claude Code", conversation: "thread:th", where: "Chat", kind: "command",
  detail: "bun install", files: [], network: false, cwd: "/Users/ton/Projects/app", risk: "medium", canSession: true, atMs: 0,
};
const threadAsk: PendingAsk = { ...base, id: "thread:q", ref: { source: "thread", threadId: "th", requestId: "q" } };
const tuiAsk: PendingAsk = { ...base, id: "tui:t1:s1", conversation: "t1", ref: { source: "tui", tabId: "t1", signature: "s1" } };
const fleetAsk: PendingAsk = { ...base, id: "fleet:a1", conversation: null, ref: { source: "fleet", approvalId: "a1" } };

const tuiPrompt = {
  kind: "command" as const,
  title: "Do you want to proceed?",
  detail: "bun install",
  signature: "s1",
  choices: [{ id: "allow" as const, label: "Yes", keys: "1" }, { id: "deny" as const, label: "No", keys: "\u001b" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.alerta.mockImplementation(() => Promise.resolve({}));
  usePermissions.setState({ rules: [rule], rulesLoaded: true, answered: {}, tui: [], selected: null });
});

describe("regras «Sempre permitir»", () => {
  it("remover_regra_com_ipc_falho_mantem_regra", async () => {
    mocks.ruleRemove.mockRejectedValue(new Error("banco ocupado"));
    mocks.rules.mockResolvedValue([{ ...rule }]);

    await removeRule("r1");

    // A regra continua gravada: a tela não pode mostrar que ela sumiu, e a pessoa é avisada.
    expect(usePermissions.getState().rules.map((r) => r.id)).toEqual(["r1"]);
    expect(mocks.alerta).toHaveBeenCalledTimes(1);
  });

  it("remover_regra_confirmada_sai_da_tela", async () => {
    mocks.ruleRemove.mockResolvedValue(true);
    mocks.rules.mockResolvedValue([]);

    await removeRule("r1");

    expect(usePermissions.getState().rules).toEqual([]);
    expect(mocks.alerta).not.toHaveBeenCalled();
  });

  it("editar_regra_com_ipc_falho_mantem_o_padrao_salvo", async () => {
    mocks.ruleUpdate.mockRejectedValue(new Error("banco ocupado"));
    mocks.rules.mockResolvedValue([{ ...rule }]);

    await updateRule("r1", { pattern: "*" });

    // O padrão que decide os pedidos é o que está gravado, não o rascunho que a pessoa digitou.
    expect(usePermissions.getState().rules[0]?.pattern).toBe("bun *");
    expect(mocks.alerta).toHaveBeenCalledTimes(1);
  });

  it("erro_ao_ler_regras_nao_zera_a_lista", async () => {
    usePermissions.setState({ rulesLoaded: false });
    mocks.rules.mockRejectedValue(new Error("ipc"));

    await loadRules();

    expect(usePermissions.getState().rules).toEqual([rule]);
    expect(usePermissions.getState().rulesLoaded).toBe(false);
    expect(mocks.alerta).toHaveBeenCalledTimes(1);
  });
});

describe("resposta a pedidos", () => {
  it("responder_pedido_com_falha_mantem_pedido", async () => {
    mocks.answerRequest.mockResolvedValue(false);

    await answerAsk(threadAsk, "allow");

    // Só some da caixa quando o agente confirma o recebimento; falhou, o pedido segue pendente e a pessoa vê o aviso.
    expect(usePermissions.getState().answered[threadAsk.id]).toBeUndefined();
    expect(mocks.alerta).toHaveBeenCalledTimes(1);
  });

  it("responder_pedido_confirmado_sai_da_caixa", async () => {
    mocks.answerRequest.mockResolvedValue(true);

    await answerAsk(threadAsk, "allow");

    expect(usePermissions.getState().answered[threadAsk.id]).toBe(true);
    expect(mocks.alerta).not.toHaveBeenCalled();
  });

  it("tecla_nao_enviada_ao_terminal_mantem_pedido_de_tui", async () => {
    usePermissions.setState({ tui: [{ tabId: "t1", who: "Claude", prompt: tuiPrompt, atMs: 0 }] });
    mocks.answerTerminalPrompt.mockReturnValue(false);

    await answerAsk(tuiAsk, "allow");

    expect(usePermissions.getState().answered[tuiAsk.id]).toBeUndefined();
    expect(mocks.alerta).toHaveBeenCalledTimes(1);
  });

  it("decisao_da_frota_recusada_mantem_pedido", async () => {
    mocks.decideApproval.mockRejectedValue(new Error("fora do ar"));

    await answerAsk(fleetAsk, "allow");

    expect(usePermissions.getState().answered[fleetAsk.id]).toBeUndefined();
    expect(mocks.alerta).toHaveBeenCalledTimes(1);
  });
});
