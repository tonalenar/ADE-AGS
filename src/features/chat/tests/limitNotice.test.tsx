// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  plan: null as null | { threadId: string; at: number; createdAtMs: number },
  pending: null as null | Record<string, unknown>,
  calls: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    fake.calls.push(cmd);
    switch (cmd) {
      case "chat_limit_resume_get": return fake.plan;
      case "chat_limit_resume_cancel": fake.plan = null; return null;
      case "chat_pool_pending": return fake.pending;
      case "chat_pool_accept":
      case "chat_pool_dismiss": return null;
      default: throw new Error(`comando inesperado: ${cmd}`);
    }
  }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { NoticeRow } from "../timeline/NoticeRow";
import type { TimelineItem } from "../timeline/types";

const notice = (label: string, text: string) => ({ id: `n:${label}`, kind: "notice", label, text }) as unknown as TimelineItem;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fake.plan = null;
  fake.pending = null;
  fake.calls.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const buttons = () => [...host.querySelectorAll("button")].map((b) => b.textContent);

describe("avisos do limite de uso", () => {
  it("a retomada agendada mostra a hora e deixa cancelar enquanto vale", async () => {
    fake.plan = { threadId: "t1", at: 1_000, createdAtMs: 1 };
    await act(async () => root.render(<NoticeRow item={notice("limitResume", "O limite esgotou. Retomo sozinho às 15:01, quando renovar.")} threadId="t1" />));
    expect(host.textContent).toContain("chat.timeline.notice.limitResume");
    expect(host.textContent).toContain("Retomo sozinho às 15:01");
    expect(buttons()).toEqual(["chat.timeline.notice.limitResumeCancel"]);

    await act(async () => (host.querySelector("button") as HTMLButtonElement).click());
    expect(fake.calls).toContain("chat_limit_resume_cancel");
    expect(buttons()).toEqual([]);
  });

  it("sem plano (já cancelada ou já retomada) não há botão", async () => {
    await act(async () => root.render(<NoticeRow item={notice("limitResume", "texto")} threadId="t1" />));
    expect(buttons()).toEqual([]);
  });

  it("a retomada que aconteceu e a que falhou só informam", async () => {
    await act(async () => root.render(<NoticeRow item={notice("limitResumed", "O limite renovou.")} threadId="t1" />));
    expect(host.textContent).toContain("chat.timeline.notice.limitResumed");
    expect(buttons()).toEqual([]);
    await act(async () => root.render(<NoticeRow item={notice("limitResumeFailed", "Não consegui retomar sozinho: ocupada.")} threadId="t1" />));
    expect(host.textContent).toContain("chat.timeline.notice.limitResumeFailed");
  });
});

describe("a oferta do modelo reserva", () => {
  it("pergunta com os botões de aceitar e dispensar enquanto a pergunta continua pendente", async () => {
    fake.pending = { kind: "fallback", to: null, toLabel: "Claude Code · opus", request: "faça x", agentId: "claude-code", model: "opus" };
    await act(async () => root.render(<NoticeRow item={notice("fallbackOffer", "O limite de Codex esgotou. Continuar com o modelo reserva do projeto (Claude Code · opus)?")} threadId="t1" />));
    expect(buttons()).toEqual(["chat.timeline.notice.fallbackAccept", "chat.timeline.notice.poolDismiss"]);

    await act(async () => (host.querySelector("button") as HTMLButtonElement).click());
    expect(fake.calls).toContain("chat_pool_accept");
    expect(buttons()).toEqual([]);
  });

  it("sem pergunta pendente (já respondida) não há botões", async () => {
    await act(async () => root.render(<NoticeRow item={notice("fallbackOffer", "texto")} threadId="t1" />));
    expect(buttons()).toEqual([]);
  });
});
