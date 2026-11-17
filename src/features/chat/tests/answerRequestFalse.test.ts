import { beforeEach, describe, expect, it, vi } from "vitest";

// A store estruturada responde o pedido pelo IPC. Uma falha (`false` ou erro) deixa o pedido na conversa e grava o aviso
// FORA do pedido, num mapa por id: uma releitura do fio troca `requests` e não pode apagar o aviso enquanto o pedido
// estiver na caixa (rodada 3 do PR11).
const mocks = vi.hoisted(() => ({
  requestAnswer: vi.fn(),
  threadItems: vi.fn(),
  threadRequests: vi.fn(),
  threadStatus: vi.fn(),
  threadGoalGet: vi.fn(),
  threadProviderConfig: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@/features/chat/structured/ipc", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chatRequestAnswer: mocks.requestAnswer,
  chatThreadItems: mocks.threadItems,
  chatThreadRequests: mocks.threadRequests,
  chatThreadStatus: mocks.threadStatus,
  chatThreadGoalGet: mocks.threadGoalGet,
  chatThreadProviderConfig: mocks.threadProviderConfig,
}));
vi.mock("@/features/chat/shelf", () => ({ unsnoozeConversation: vi.fn() }));

import { threadAsks } from "@/features/chat/permissions/askSources";
import { EMPTY_LIVE, forgetGoneAnswerErrors, type ThreadLive } from "@/features/chat/structured/model";
import type { RequestRow } from "@/features/chat/structured/ipc";
import { answerRequest, hydrateThread, removeDeletedSideChat, useStructured } from "@/features/chat/structured/store";

const KEY = "chat.permission.answerFailed";
const thread = { id: "th", agentId: "codex", title: "Chat", cwd: "/Users/ton/app", model: null } as never;
const request = (id = "q"): RequestRow => ({ id, threadId: "th", kind: "command", itemId: null, title: "bun install", detail: "bun install", options: null, state: "pending", createdAt: 1 });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.threadItems.mockResolvedValue([]);
  mocks.threadRequests.mockResolvedValue([]);
  mocks.threadStatus.mockResolvedValue({ alive: true, working: false });
  mocks.threadGoalGet.mockResolvedValue(null);
  mocks.threadProviderConfig.mockResolvedValue(null);
  useStructured.setState({ live: { th: { ...EMPTY_LIVE, requests: [request()] } }, answerErrors: {}, hydrated: {} });
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

  it("hydrateThread_com_caixa_vazia_no_servidor_remove_pedido_resolvido_e_aviso", async () => {
    mocks.requestAnswer.mockResolvedValue(false);
    await answerRequest("th", "q", "allow");
    useStructured.setState({ hydrated: {} });
    mocks.threadRequests.mockResolvedValueOnce([]);

    await hydrateThread("th");

    expect(useStructured.getState().live.th?.requests).toEqual([]);
    expect(useStructured.getState().answerErrors.q).toBeUndefined();
  });

  it("hydrateThread_preserva_pedido_recebido_por_evento_depois_do_inicio_da_leitura", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    let resolveRequests!: (rows: RequestRow[]) => void;
    mocks.threadRequests.mockReturnValueOnce(new Promise((resolve) => { resolveRequests = resolve; }));
    useStructured.setState({ live: { th: { ...EMPTY_LIVE } }, answerErrors: {} });
    useStructured.setState((s) => ({ hydrated: { ...s.hydrated, th: false } }));

    const hydration = hydrateThread("th");
    useStructured.setState((s) => ({
      live: { ...s.live, th: { ...s.live.th!, requests: [{ ...request("new-event"), createdAt: 1001 }] } },
    }));
    resolveRequests([]);
    await hydration;

    expect(useStructured.getState().live.th?.requests.map((row) => row.id)).toEqual(["new-event"]);
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

  it("excluir_conversa_lateral_remove_os_avisos_dos_pedidos_dela", () => {
    useStructured.setState({
      live: { th: { ...EMPTY_LIVE, requests: [request("q"), request("r")] }, other: { ...EMPTY_LIVE, requests: [request("other-request")] } },
      answerErrors: { q: KEY, r: KEY, "other-request": KEY },
      hydrated: { th: true, other: true },
    });

    removeDeletedSideChat("th");

    expect(useStructured.getState().live.th).toBeUndefined();
    expect(useStructured.getState().answerErrors).toEqual({ "other-request": KEY });
  });
});
