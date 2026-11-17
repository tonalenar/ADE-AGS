import { beforeEach, describe, expect, it, vi } from "vitest";

// A store estruturada responde o pedido pelo IPC. Uma falha (`false` ou erro) deixa o pedido na conversa e grava o aviso
// FORA do pedido, num mapa por id: uma releitura do fio troca `requests` e não pode apagar o aviso enquanto o pedido
// estiver na caixa (rodada 3 do PR11).
const mocks = vi.hoisted(() => ({ requestAnswer: vi.fn() }));

vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@/features/chat/structured/ipc", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chatRequestAnswer: mocks.requestAnswer,
}));
vi.mock("@/features/chat/shelf", () => ({ unsnoozeConversation: vi.fn() }));

import { threadAsks } from "@/features/chat/permissions/askSources";
import { EMPTY_LIVE, forgetGoneAnswerErrors, type ThreadLive } from "@/features/chat/structured/model";
import { answerRequest, useStructured } from "@/features/chat/structured/store";

const KEY = "chat.permission.answerFailed";
const thread = { id: "th", agentId: "codex", title: "Chat", cwd: "/Users/ton/app", model: null } as never;
const request = (id = "q") => ({ id, threadId: "th", kind: "command", itemId: null, title: "bun install", detail: "bun install", options: null, state: "pending", createdAt: 1 }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  useStructured.setState({ live: { th: { ...EMPTY_LIVE, requests: [request()] } }, answerErrors: {} });
});

describe("falha de resposta: o aviso fica fora do pedido (rodada 3)", () => {
  it("answerRequest_com_ipc_retornando_false_guarda_o_aviso_fora_do_pedido", async () => {
    mocks.requestAnswer.mockResolvedValue(false);

    await answerRequest("th", "q", "allow");

    expect(useStructured.getState().answerErrors.q).toBe(KEY);
    const kept = useStructured.getState().live.th?.requests[0];
    expect(kept?.id).toBe("q");
    expect(Object.keys(kept ?? {})).not.toContain("errorKey");
  });

  it("aviso_sobrevive_a_releitura_do_fio", async () => {
    mocks.requestAnswer.mockResolvedValue(false);
    await answerRequest("th", "q", "allow");

    // A releitura troca `requests` por linhas novas, sem nada da falha.
    useStructured.setState((s) => ({ live: { ...s.live, th: { ...EMPTY_LIVE, requests: [request()] } } }));

    const [ask] = threadAsks(thread, useStructured.getState().live.th?.requests ?? [], [], () => "Codex", useStructured.getState().answerErrors);
    expect(ask?.id).toBe("thread:q");
    expect(ask?.errorKey).toBe(KEY);
  });

  it("resposta_confirmada_depois_tira_o_aviso", async () => {
    mocks.requestAnswer.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await answerRequest("th", "q", "allow");
    expect(useStructured.getState().answerErrors.q).toBe(KEY);

    await answerRequest("th", "q", "allow");

    expect(useStructured.getState().answerErrors.q).toBeUndefined();
    expect(useStructured.getState().live.th?.requests).toEqual([]);
  });

  it("pedido_que_sai_da_caixa_leva_o_aviso_junto", () => {
    const before = { ...EMPTY_LIVE, requests: [request("q"), request("r")] } as ThreadLive;
    const after = { ...EMPTY_LIVE, requests: [request("r")] } as ThreadLive;
    const errors = { q: KEY, r: KEY };

    expect(forgetGoneAnswerErrors(before, after, errors)).toEqual({ r: KEY });
    // Nada saiu: o mapa é o mesmo objeto (sem trabalho à toa a cada evento).
    expect(forgetGoneAnswerErrors(before, before, errors)).toBe(errors);
  });
});
