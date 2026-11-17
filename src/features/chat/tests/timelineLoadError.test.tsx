// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18next from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import pt from "@/i18n/locales/pt-BR.json";

const i18n = i18next.createInstance();
await i18n.init({ lng: "pt-BR", resources: { "pt-BR": { translation: pt } }, interpolation: { escapeValue: false } });

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => i18n.t(key, o), i18n }) }));
vi.mock("../LiveActivity", () => ({ PlanCard: () => null }));

import { TimelineView } from "../timeline/ConversationTimeline";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("a timeline de uma conversa que não abriu mostra o erro e oferece tentar de novo", () => {
  it("com a leitura falha, o erro aparece (sem o «Carregando…») e o botão chama o novo carregamento", async () => {
    const retry = vi.fn();
    await act(async () => {
      root.render(<TimelineView items={[]} loaded={false} working={false} approval={null} agentLabel="Claude" agentId="claude-code" loadError="banco ocupado" onRetryLoad={retry} />);
    });
    expect(host.textContent).toContain("Não foi possível abrir a conversa");
    expect(host.textContent).not.toContain("Carregando");
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Tentar de novo");
    expect(button).toBeDefined();
    await act(async () => { button!.click(); });
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
