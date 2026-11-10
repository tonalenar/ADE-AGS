/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18next from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import pt from "@/i18n/locales/pt-BR.json";

const i18n = i18next.createInstance();
await i18n.init({ lng: "pt-BR", resources: { "pt-BR": { translation: pt } }, interpolation: { escapeValue: false } });

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => i18n.t(key, options), i18n }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { LogFailureNotice } from "../LogFailureNotice";
import { recordLogFailure, useStructured } from "../store";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const sinal = (threadId: string, failureId: number, error = "disco cheio") => ({
  scope: "chat",
  threadId,
  taskId: null,
  attemptId: null,
  eventType: "assistant",
  error,
  attempts: 3,
  failureId,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  useStructured.setState({ logFailures: {} });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("LogFailureNotice", () => {
  it("é uma região de status que fica vazia sem falha e mostra o motivo quando há uma", () => {
    act(() => root.render(<LogFailureNotice threadId="t1" />));
    const regiao = host.querySelector('[role="status"]');
    expect(regiao).not.toBeNull();
    expect(regiao?.textContent).toBe("");
    act(() => recordLogFailure(sinal("t1", 7)));
    expect(regiao?.textContent).toContain("disco cheio");
  });

  it("não mostra a falha de outra conversa", () => {
    act(() => root.render(<LogFailureNotice threadId="t1" />));
    act(() => recordLogFailure(sinal("t2", 9, "motivo de outra conversa")));
    expect(host.textContent).not.toContain("motivo de outra conversa");
  });

  it("o botão dispensa o aviso e tem nome acessível", () => {
    act(() => root.render(<LogFailureNotice threadId="t1" />));
    act(() => recordLogFailure(sinal("t1", 7)));
    const botao = host.querySelector("button") as HTMLButtonElement;
    expect(botao.getAttribute("aria-label")).toBe(pt["chat.logFailure.dismiss"]);
    act(() => botao.click());
    expect(host.querySelector('[role="status"]')?.textContent).toBe("");
  });
});
