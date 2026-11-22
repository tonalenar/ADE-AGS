// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts && Object.keys(opts).some((k) => k !== "defaultValue") ? `${key}${JSON.stringify(opts)}` : key),
    i18n: { language: "pt-BR" },
  }),
}));

const pool = vi.hoisted(() => ({
  accepted: [] as string[],
  pending: { kind: "join", to: null, toLabel: "Pool Teste", request: null } as { kind: string; to: string | null; toLabel: string; request: string | null } | null,
}));
vi.mock("@/features/accounts/chatPool", () => ({
  chatPoolPending: () => Promise.resolve(pool.pending),
  chatPoolAccept: (id: string) => { pool.accepted.push(id); return Promise.resolve(); },
  chatPoolDismiss: () => Promise.resolve(),
}));

import { NoticeRow } from "@/features/chat/timeline/NoticeRow";
import type { TimelineItem } from "@/features/chat/timeline/types";

let root: Root | null = null;
let host: HTMLDivElement;

async function render(node: React.ReactNode) {
  await act(async () => { root!.render(node); });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  host.remove();
});

const notice = (label: string, text: string): TimelineItem => ({ kind: "notice", id: `n-${label}`, label, text });

describe("NoticeRow", () => {
  it("a sessão que não voltou mostra a frase do código e o motivo", async () => {
    await render(<NoticeRow item={notice("resumeLost", "A sessão anterior não pôde ser retomada; o agente recomeçou sem o histórico dele. Motivo: thread not found")} />);
    const text = host.querySelector('[role="status"]')!.textContent!;
    expect(text).toContain("chat.timeline.notice.resumeLost");
    expect(text).toContain("thread not found");
  });

  it("a mensagem descartada da fila aparece com o texto e o botão de reenviar", async () => {
    const onResend = vi.fn();
    await render(<NoticeRow item={notice("queueDropped", "e o lint?")} onResend={onResend} />);
    expect(host.textContent).toContain("chat.timeline.notice.queueDropped");
    expect(host.textContent).toContain("e o lint?");
    await act(async () => { host.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onResend).toHaveBeenCalledWith("e o lint?");
  });

  it("sem a função de reenviar não há botão; código desconhecido mostra o texto do app", async () => {
    await render(<NoticeRow item={notice("queueDropped", "x")} />);
    expect(host.querySelector("button")).toBeNull();
    await render(<NoticeRow item={notice("algoNovo", "aviso novo")} />);
    expect(host.querySelector('[role="status"]')!.textContent).toBe("aviso novo");
  });

  it("a resposta cortada pelo limite de tokens tem a frase do catálogo, mesmo sem texto", async () => {
    await render(<NoticeRow item={notice("responseTruncated", "")} />);
    expect(host.querySelector('[role="status"]')!.textContent).toContain("chat.timeline.notice.responseTruncated");
  });
});

describe("NoticeRow do pool de contas", () => {
  it("a troca mostra o título do código e a frase do app, sem botões", async () => {
    await render(<NoticeRow threadId="t1" item={notice("poolSwitch", "A conta A esgotou o limite (renova 13:10). Seguindo na conta B.")} />);
    const text = host.querySelector('[role="status"]')!.textContent!;
    expect(text).toContain("chat.timeline.notice.poolSwitch");
    expect(text).toContain("Seguindo na conta B");
    expect(host.querySelectorAll("button").length).toBe(0);
  });

  it("a oferta de pool (conversa fora de pool) mostra «usar o pool» e aceitar chama o backend", async () => {
    pool.accepted = [];
    pool.pending = { kind: "join", to: null, toLabel: "Pool Teste", request: null };
    await render(<NoticeRow threadId="t1" item={notice("poolOffer", "A conta Ton esgotou o limite e esta conversa não está num pool.")} />);
    const accept = [...host.querySelectorAll("button")].find((b) => b.textContent === "chat.timeline.notice.poolJoinAccept");
    expect(accept).toBeTruthy();
    await act(async () => { accept!.click(); });
    expect(pool.accepted).toEqual(["t1"]);
  });

  it("não mostra botões quando o código do aviso não combina com pending.kind ou quando não é o aviso ativo", async () => {
    pool.pending = { kind: "return", to: null, toLabel: "Principal", request: null };
    // poolAsk antigo não pode mostrar botão de pending.kind === "return"
    await render(<NoticeRow threadId="t1" item={notice("poolAsk", "A conta A esgotou.")} />);
    expect(host.querySelectorAll("button").length).toBe(0);

    // poolReturnAsk inativo (histórico) não pode mostrar botões
    await render(<NoticeRow threadId="t1" activePoolNotice={false} item={notice("poolReturnAsk", "A conta A renovou.")} />);
    expect(host.querySelectorAll("button").length).toBe(0);

    // poolReturnAsk ativo com pending.kind === "return" mostra os botões
    await render(<NoticeRow threadId="t1" activePoolNotice={true} item={notice("poolReturnAsk", "A conta A renovou.")} />);
    expect(host.querySelectorAll("button").length).toBe(2);
  });

  it("traduz avisos estruturados em JSON do pool e da troca manual de conta", async () => {
    await render(<NoticeRow threadId="t1" item={notice("poolSwitch", JSON.stringify({ from: "Ton", to: "Erist", resetsAt: "13:10" }))} />);
    expect(host.textContent).toContain('chat.timeline.notice.poolSwitchBody{"from":"Ton","to":"Erist","resetsAt":"13:10"}');

    await render(<NoticeRow threadId="t1" item={notice("accountSwitch", JSON.stringify({ to: "Erist" }))} />);
    expect(host.textContent).toContain("chat.timeline.notice.accountSwitch");
    expect(host.textContent).toContain('chat.timeline.notice.accountSwitchBody{"to":"Erist"}');
  });
});
