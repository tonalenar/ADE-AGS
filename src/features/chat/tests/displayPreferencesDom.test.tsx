// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DISPLAY_PREFS, saveDisplayPrefs } from "@/features/settings/displayPreferences";

import { EffortLevel } from "../EffortLevel";
import { ContextStrip } from "../NewConversation";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(null) }));

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
  saveDisplayPrefs(DEFAULT_DISPLAY_PREFS);
});

describe("esforço no composer", () => {
  it("com o nome (o padrão), mostra o texto do nível e nenhuma barra", async () => {
    saveDisplayPrefs({ ...DEFAULT_DISPLAY_PREFS, effortDisplay: "label" });
    await act(async () => { root.render(<EffortLevel value="medium" efforts={["low", "medium", "high"]} label="Médio" />); });
    expect(host.textContent).toBe("Médio");
    expect(host.querySelector("[role='img']")).toBeNull();
  });

  it("em barras, uma barra por nível e acende até o escolhido; o nome fica para o leitor de tela", async () => {
    saveDisplayPrefs({ ...DEFAULT_DISPLAY_PREFS, effortDisplay: "bars" });
    await act(async () => { root.render(<EffortLevel value="medium" efforts={["low", "medium", "high"]} label="Médio" />); });
    const img = host.querySelector("[role='img']");
    expect(img?.getAttribute("aria-label")).toBe("Médio");
    const bars = [...host.querySelectorAll("[aria-hidden='true']")];
    expect(bars).toHaveLength(3);
    expect(bars.filter((bar) => bar.classList.contains("bg-current"))).toHaveLength(2);
  });

  it("um nível que o modelo não oferece cai no nome, mesmo em barras", async () => {
    saveDisplayPrefs({ ...DEFAULT_DISPLAY_PREFS, effortDisplay: "bars" });
    await act(async () => { root.render(<EffortLevel value="max" efforts={["low", "high"]} label="Máximo" />); });
    expect(host.textContent).toBe("Máximo");
  });
});

describe("contexto do composer na conversa", () => {
  it("desligado, a branch sai da faixa, mas o menu de scripts (os filhos) continua", async () => {
    await act(async () => {
      root.render(
        <ContextStrip branch="feat/x" worktree showContext={false}>
          <span data-testid="scripts">scripts</span>
        </ContextStrip>,
      );
    });
    expect(host.textContent).not.toContain("feat/x");
    expect(host.querySelector("[data-testid='scripts']")).not.toBeNull();
  });

  it("ligado, a branch aparece na faixa", async () => {
    await act(async () => {
      root.render(<ContextStrip branch="feat/x" worktree showContext><span>s</span></ContextStrip>);
    });
    expect(host.textContent).toContain("feat/x");
  });
});
