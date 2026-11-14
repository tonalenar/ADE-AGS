// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18next from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import pt from "@/i18n/locales/pt-BR.json";

const i18n = i18next.createInstance();
await i18n.init({ lng: "pt-BR", resources: { "pt-BR": { translation: pt } }, interpolation: { escapeValue: false } });

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => i18n.t(key, o), i18n }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("../LiveActivity", () => ({ PlanCard: () => null }));

import { TimelineView } from "../timeline/ConversationTimeline";
import type { TimelineItem } from "../timeline/types";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

const renderTimeline = (items: TimelineItem[], opts: { working?: boolean; streaming?: ReadonlySet<string> } = {}) =>
  act(async () => {
    root.render(
      <TimelineView
        items={items}
        loaded
        working={opts.working ?? true}
        approval={null}
        live
        streaming={opts.streaming}
        agentLabel="Claude"
        agentId="claude-code"
      />,
    );
  });

describe("paridade visual da timeline com o T3 Code (pensar → ferramentas → texto → fecho)", () => {
  it("durante turno em aberto (mesmo com live=true), exibe o cabeçalho 'Trabalhando há …' abaixo da fala da pessoa sem ponto pulsante", async () => {
    const now = Date.now() - 5000;
    await renderTimeline([{ kind: "user", id: "u1", text: "explique", at: now }], { working: true });
    const row = host.querySelector("[data-working-row]") as HTMLElement | null;
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("Trabalhando há");
    expect(row!.querySelector(".animate-pulse")).toBeNull();
  });

  it("texto em streaming marca data-streaming='true' em .chat-markdown (fade @starting-style, sem cc-stream-caret) e remove ao finalizar", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
    try {
      const items: TimelineItem[] = [
        { kind: "user", id: "u-stream", text: "diga oi", at: 1000 },
        { kind: "assistant", id: "a-stream", text: "Olá! Aqui está a resposta.", at: 2000 },
      ];
      await renderTimeline(items, { working: false, streaming: new Set(["a-stream"]) });
      expect(host.querySelector(".cc-stream-caret")).toBeNull();
      const md = host.querySelector(".chat-markdown[data-streaming='true']");
      expect(md).not.toBeNull();
      // O markdown completo deve estar no DOM no primeiro render; só os nós inseridos recebem fade.
      expect(md?.textContent).toContain("Olá! Aqui está a resposta.");

      await renderTimeline([...items, { kind: "turnEnd", id: "e-stream", durationMs: 3000, at: 4000 }], { working: false });
      await act(async () => { vi.advanceTimersByTime(1600); });
      expect(host.querySelector(".chat-markdown[data-streaming]")).toBeNull();
      expect(host.textContent).toContain("Olá! Aqui está a resposta.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("turno finalizado com sucesso recolhe automaticamente atrás de 'Trabalhou por Xs' e revela raciocínio ao expandir", async () => {
    const items: TimelineItem[] = [
      { kind: "user", id: "u1", text: "verifique", at: 1000 },
      { kind: "reasoning", id: "r1", text: "Analisando arquivos internos.", at: 1500 },
      { kind: "tool", id: "t1", tool: "read", path: "/a.ts", label: "a.ts", status: "done", at: 2000 },
      { kind: "assistant", id: "a-fold", text: "Tudo certo.", at: 3000 },
      { kind: "turnEnd", id: "e1", durationMs: 4000, at: 5000 },
    ];
    await renderTimeline(items, { working: false });
    const fold = host.querySelector("[data-turn-fold] button[aria-expanded]") as HTMLButtonElement;
    expect(fold).not.toBeNull();
    expect(fold.textContent).toContain("Trabalhou por 4s");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector("[data-reasoning]")).toBeNull();
    expect(host.textContent).toContain("Tudo certo.");

    await act(async () => { fold.click(); });
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector("[data-reasoning]")?.textContent).toContain("Analisando arquivos internos.");
  });

  it("turno interrompido com duração exibe 'Você parou após Xs' e permanece aberto", async () => {
    const items: TimelineItem[] = [
      { kind: "user", id: "u1", text: "rode", at: 1000 },
      { kind: "tool", id: "t1", tool: "command", label: "cargo test", status: "done", at: 2000 },
      { kind: "turnEnd", id: "e1", durationMs: 6000, interrupted: true, at: 7000 },
    ];
    await renderTimeline(items, { working: false });
    const fold = host.querySelector("[data-turn-fold] button[aria-expanded]") as HTMLButtonElement;
    expect(fold.textContent).toContain("Você parou após 6s");
    expect(fold.getAttribute("aria-expanded")).toBe("true");
  });

  it("turno com erro permanece aberto por padrão e exibe o aviso do erro", async () => {
    const items: TimelineItem[] = [
      { kind: "user", id: "u1", text: "rode", at: 1000 },
      { kind: "tool", id: "t1", tool: "command", label: "npm test", status: "error", at: 2000 },
      { kind: "turnEnd", id: "e1", durationMs: 2000, text: "processo falhou", at: 3000 },
    ];
    await renderTimeline(items, { working: false });
    const fold = host.querySelector("[data-turn-fold] button[aria-expanded]") as HTMLButtonElement;
    expect(fold.textContent).toContain("Não concluído");
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("processo falhou");
  });
});
