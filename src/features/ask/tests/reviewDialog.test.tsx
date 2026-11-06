/** @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import ptBR from "@/i18n/locales/pt-BR.json";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string | number>) => {
      let text = (ptBR as Record<string, string>)[key] ?? key;
      for (const [k, v] of Object.entries(options ?? {})) text = text.replace(new RegExp(`{{${k}}}`, "g"), String(v));
      return text;
    },
  }),
}));
vi.mock("neogestify-ui-components", () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) =>
    createElement("button", { onClick }, children),
  Input: () => createElement("input"),
}));
// O diálogo real traz o Modal da biblioteca; aqui basta o título, o corpo, o rodapé e o fechar.
vi.mock("@/shared/ui/AppDialog", () => ({
  AppDialog: ({ title, footer, onClose, children }: { title: string; footer: React.ReactNode; onClose: () => void; children: React.ReactNode }) =>
    createElement("div", { role: "dialog", "aria-label": title },
      createElement("button", { "data-close": "", onClick: onClose }, "x"),
      children,
      footer),
}));

import { AskDialog } from "../AskDialog";
import { parseReview, useAskStore, type UserQuestion } from "../askStore";

const ALLOW = "Autorizar esta ação";
const ALWAYS = "Autorizar sempre neste aparelho";
const DENY = "Recusar";

function ask(over: Partial<UserQuestion>, resolve = vi.fn()): ReturnType<typeof vi.fn> {
  useAskStore.getState().add({
    id: "q1",
    question: "Confirma esta ação no simulador iOS?\nFoto local para revisão: /tmp/x.png",
    options: [ALLOW, ALWAYS, DENY],
    from: "Codex",
    fromId: "tab-1",
    expiresAt: Date.now() + 60_000,
    review: { surface: "ios", action: "Tocar em «Geral»", image: "data:image/png;base64,AAAA", point: [0.25, 0.5] },
    resolve,
    ...over,
  });
  return resolve;
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  useAskStore.setState({ questions: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = () => act(() => root.render(createElement(AskDialog)));
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;

describe("confirmação do JEV", () => {
  it("mostra a ação, a foto com o ponto e nenhum caminho de arquivo", () => {
    ask({});
    render();
    expect(host.querySelector("[role=dialog]")?.getAttribute("aria-label")).toBe("Autorizar ação no iPhone?");
    expect(host.textContent).toContain("Tocar em «Geral»");
    expect(host.textContent).toContain("Codex");
    expect(host.textContent).not.toContain("/tmp/x.png");
    expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    const marker = host.querySelector<HTMLElement>("span[aria-hidden]");
    expect(marker?.style.left).toBe("25%");
    expect(marker?.style.top).toBe("50%");
  });

  it("cada botão devolve a opção original do backend; fechar é recusar", () => {
    for (const [label, expected] of [["Autorizar", ALLOW], ["Sempre neste aparelho", ALWAYS], ["Recusar", DENY], ["x", DENY]] as const) {
      const resolve = ask({});
      render();
      act(() => button(label).click());
      expect(resolve).toHaveBeenCalledWith(expected);
      expect(useAskStore.getState().questions).toHaveLength(0);
    }
  });

  it("sem a opção «sempre» não oferece o botão", () => {
    ask({ options: [ALLOW, DENY] });
    render();
    expect(button("Sempre neste aparelho")).toBeUndefined();
    expect(button("Autorizar")).toBeDefined();
  });

  it("pergunta comum continua com o texto e as opções como antes", () => {
    ask({ review: undefined, options: ["A", "B"], question: "Qual conta?" });
    render();
    expect(host.textContent).toContain("Qual conta?");
    expect(button("A")).toBeDefined();
  });
});

describe("parseReview", () => {
  it("aceita só o formato do backend e descarta foto ou ponto inválidos", () => {
    const ok = { kind: "computer_use", surface: "mac", action: " Rolar para baixo ", image: "data:image/png;base64,AA", point: [0.1, 1] };
    expect(parseReview(ok)).toEqual({ surface: "mac", action: "Rolar para baixo", image: "data:image/png;base64,AA", point: [0.1, 1] });
    expect(parseReview({ ...ok, image: "file:///etc/passwd", point: [2, 0] })).toEqual({ surface: "mac", action: "Rolar para baixo", image: undefined, point: undefined });
    for (const bad of [null, "x", { ...ok, kind: "outro" }, { ...ok, surface: "android" }, { ...ok, action: " " }]) {
      expect(parseReview(bad)).toBeUndefined();
    }
  });
});
