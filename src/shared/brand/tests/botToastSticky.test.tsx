/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../Pet", () => ({
  Pet: () => null,
  usePetStatus: () => ({ level: 1 }),
}));

import { announceResult } from "@/features/agents/AgentUpdateWatcher";

import { BotToastHost } from "../BotToastHost";
import { DEFAULT_BOT_TOAST_MS, MAX_BOT_TOASTS, showBotToast, useBotToastStore } from "../botToastStore";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  useBotToastStore.setState({ toasts: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const titles = () => useBotToastStore.getState().toasts.map((toast) => toast.title);

/**
 * Regressão proibida (Fase 6): o aviso explícito de atualização de agente fica até a dispensa manual.
 * Nem aviso novo nem o tempo o removem. Ver `botToastStore.ts` (`sticky`) e `AgentUpdateWatcher.tsx`.
 */
describe("aviso sticky de atualização de agente", () => {
  it("avisos novos, em qualquer quantidade, não empurram o sticky para fora", () => {
    showBotToast({ title: "Codex", text: "atualizado", sticky: true });
    for (let i = 0; i < MAX_BOT_TOASTS * 4; i += 1) showBotToast({ title: `rotina ${i}`, text: "x" });
    expect(titles()).toContain("Codex");
    expect(useBotToastStore.getState().toasts.filter((toast) => !toast.sticky)).toHaveLength(MAX_BOT_TOASTS);
  });

  it("vários sticky convivem: nenhum cede lugar a outro sticky", () => {
    for (let i = 0; i < MAX_BOT_TOASTS + 3; i += 1) showBotToast({ title: `agente ${i}`, text: "x", sticky: true });
    expect(useBotToastStore.getState().toasts).toHaveLength(MAX_BOT_TOASTS + 3);
  });

  it("dispensar outro aviso não toca no sticky", () => {
    showBotToast({ title: "Codex", text: "atualizado", sticky: true });
    const other = showBotToast({ title: "outro", text: "x" });
    useBotToastStore.getState().dismiss(other);
    expect(titles()).toEqual(["Codex"]);
  });

  it("o tempo não remove o sticky, mas remove o aviso comum", async () => {
    showBotToast({ title: "Codex", text: "atualizado", sticky: true });
    showBotToast({ title: "comum", text: "x" });
    await act(async () => { root.render(<BotToastHost />); });
    expect(host.textContent).toContain("comum");

    await act(async () => { await vi.advanceTimersByTimeAsync(DEFAULT_BOT_TOAST_MS + 1); });
    expect(titles()).toEqual(["Codex"]);

    await act(async () => { await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000); });
    expect(titles()).toEqual(["Codex"]);
    expect(host.textContent).toContain("Codex");
  });

  it("aviso novo chegando com o sticky na tela também não o tira, nem com o tempo correndo", async () => {
    showBotToast({ title: "Codex", text: "atualizado", sticky: true });
    await act(async () => { root.render(<BotToastHost />); });
    for (let i = 0; i < 6; i += 1) {
      await act(async () => { showBotToast({ title: `novo ${i}`, text: "x" }); });
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    }
    expect(titles()).toContain("Codex");
  });

  it("só a dispensa manual (o X) fecha o sticky", async () => {
    const onDismiss = vi.fn();
    showBotToast({ title: "Codex", text: "atualizado", sticky: true, onDismiss });
    await act(async () => { root.render(<BotToastHost />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60 * 1000); });
    expect(titles()).toEqual(["Codex"]);
    const close = host.querySelector<HTMLButtonElement>('button[aria-label="btn.close"]');
    expect(close).not.toBeNull();
    await act(async () => { close?.click(); });
    expect(titles()).toEqual([]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("o resultado de uma atualização de agente, de sucesso ou falha, nasce sticky", () => {
    const t = ((key: string) => key) as never;
    announceResult(t, "Codex", { agentId: "codex", ok: true, output: "", newVersion: "0.160.0", error: null });
    announceResult(t, "Claude", { agentId: "claude-code", ok: false, output: "", newVersion: null, error: "failed" });
    const toasts = useBotToastStore.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts.every((toast) => toast.sticky === true)).toBe(true);
    for (let i = 0; i < MAX_BOT_TOASTS * 3; i += 1) showBotToast({ title: `rotina ${i}`, text: "x" });
    expect(titles()).toEqual(expect.arrayContaining(["Codex", "Claude"]));
  });
});
