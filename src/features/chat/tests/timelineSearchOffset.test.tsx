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
import type { TimelineItem } from "../timeline/types";

// O turno 2 acabou e recolheu (a busca abre o fold só para falas, não para ferramentas): a linha da ferramenta não
// está na tela, e a busca leva a conversa até o turno.
const items: TimelineItem[] = [
  { kind: "user", id: "u1", text: "primeira" },
  { kind: "assistant", id: "a1", text: "resposta um" },
  { kind: "turnEnd", id: "e1", durationMs: 1000 },
  { kind: "user", id: "u2", text: "segunda" },
  { kind: "tool", id: "t2", tool: "read", path: "/r/x.ts", label: "x.ts", status: "done" },
  { kind: "turnEnd", id: "e2", durationMs: 1000 },
  { kind: "user", id: "u3", text: "terceira" },
  { kind: "assistant", id: "a3", text: "resposta três" },
];
const TURN_TOP = 500;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // Sem layout no happy-dom, o scroller precisa de altura para o `scrollTop` aceitar a posição do turno.
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(2000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  // A subida suave do mount (`scrollTo`) não é animada aqui: no navegador, o salto da busca a cancelaria. No happy-dom ela
  // terminaria depois do salto e mascararia o resultado.
  vi.spyOn(Element.prototype, "scrollTo").mockImplementation(() => undefined);
  // O quadro é síncrono: a busca rola na hora, sem esperar a pintura.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  // A posição de cada turno na tela: o turno 2 está 500 px abaixo do topo do fio.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const turn = this.getAttribute("data-virtual-turn");
    const top = turn === "u2" ? TURN_TOP : 0;
    return { top, bottom: top + 40, left: 0, right: 0, width: 100, height: 40, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("a busca leva a conversa até o turno certo, mesmo com ele recolhido", () => {
  it("busca_no_turno_recolhido_rola_pela_posicao_medida: a rolagem usa a posição que a tela mostra, não uma estimativa", async () => {
    await act(async () => {
      root.render(<TimelineView items={items} loaded working={false} approval={null} agentLabel="Claude" agentId="claude-code" live searchTargetId="t2" searchTargetToken={1} />);
    });
    const container = host.querySelector("[class*='cc-scroll-hidden']") as HTMLElement;
    expect(container.scrollTop).toBe(TURN_TOP);
  });
});
