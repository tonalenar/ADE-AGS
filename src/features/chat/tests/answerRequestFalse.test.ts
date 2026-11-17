import { beforeEach, describe, expect, it, vi } from "vitest";

// A store estruturada responde o pedido pelo IPC. O backend devolve `false` quando o pedido já não está aberto;
// isso é falha: o pedido fica na conversa e o erro aparece.
const mocks = vi.hoisted(() => ({ requestAnswer: vi.fn() }));

vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@/features/chat/structured/ipc", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chatRequestAnswer: mocks.requestAnswer,
}));
vi.mock("@/features/chat/shelf", () => ({ unsnoozeConversation: vi.fn() }));

import { EMPTY_LIVE } from "@/features/chat/structured/model";
import { answerRequest, useStructured } from "@/features/chat/structured/store";
import { threadAsks } from "@/features/chat/permissions/askSources";

const request = { id: "q", kind: "command", title: "bun install" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  useStructured.setState({ live: { th: { ...EMPTY_LIVE, requests: [request] } } });
});

describe("answerRequest com o IPC devolvendo false (rodada 1)", () => {
  it("answerRequest_com_ipc_retornando_false_mantem_o_pedido", async () => {
    mocks.requestAnswer.mockResolvedValue(false);

    const ok = await answerRequest("th", "q", "allow");

    expect(ok).toBe(false);
    expect(useStructured.getState().live.th?.requests.map((r) => r.id)).toEqual(["q"]);
  });

  it("answerRequest_confirmada_tira_o_pedido", async () => {
    mocks.requestAnswer.mockResolvedValue(true);

    const ok = await answerRequest("th", "q", "allow");

    expect(ok).toBe(true);
    expect(useStructured.getState().live.th?.requests).toEqual([]);
  });
});

describe("answerRequest com false: o cartão mostra o aviso (rodada 2)", () => {
  // A store não traduz: guarda a chave de erro no pedido. O cartão é que traduz e mostra (ver `PermissionCard`).
  it("answerRequest_com_ipc_retornando_false_marca_o_pedido_com_chave_de_erro", async () => {
    mocks.requestAnswer.mockResolvedValue(false);

    await answerRequest("th", "q", "allow");

    expect(useStructured.getState().live.th?.requests[0]?.errorKey).toBe("chat.permission.answerFailed");
  });

  it("a_chave_de_erro_chega_ao_pedido_da_caixa_e_do_cartao", async () => {
    mocks.requestAnswer.mockResolvedValue(false);
    await answerRequest("th", "q", "allow");

    const thread = { id: "th", agentId: "codex", title: "Chat", cwd: "/Users/ton/app", model: null } as never;
    const [ask] = threadAsks(thread, useStructured.getState().live.th?.requests ?? [], [], () => "Codex");

    expect(ask?.id).toBe("thread:q");
    expect(ask?.errorKey).toBe("chat.permission.answerFailed");
  });
});
