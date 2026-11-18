// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18next from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import pt from "@/i18n/locales/pt-BR.json";

const i18n = i18next.createInstance();
await i18n.init({ lng: "pt-BR", resources: { "pt-BR": { translation: pt } }, interpolation: { escapeValue: false } });

// Espia a montagem do Markdown: cada montagem e desmontagem sai com o id da fala (`data-chat-item-id`) que a contém.
const spy = vi.hoisted(() => ({ mounts: [] as string[], unmounts: [] as string[] }));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, o?: Record<string, unknown>) => i18n.t(key, o), i18n }) }));
vi.mock("../LiveActivity", () => ({ PlanCard: () => null }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));
vi.mock("@/shared/ui/Markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/ui/Markdown")>();
  const { useLayoutEffect, useRef } = await import("react");
  function EspiaoMarkdown(props: React.ComponentProps<typeof actual.Markdown>) {
    const ancora = useRef<HTMLSpanElement>(null);
    useLayoutEffect(() => {
      const id = ancora.current?.closest("[data-chat-item-id]")?.getAttribute("data-chat-item-id") ?? "?";
      spy.mounts.push(id);
      return () => { spy.unmounts.push(id); };
    }, []);
    return <><span ref={ancora} hidden /><actual.Markdown {...props} /></>;
  }
  return { ...actual, Markdown: EspiaoMarkdown };
});

import { TimelineView } from "../timeline/ConversationTimeline";
import type { TimelineItem } from "../timeline/types";

const user: TimelineItem = { kind: "user", id: "u", text: "faça" };
const fala = (text: string): TimelineItem => ({ kind: "assistant", id: "a1", text });
const end: TimelineItem = { kind: "turnEnd", id: "e", durationMs: 4000 };
const IMAGEM = "![foto](data:image/png;base64,iVBORw0KGgo=)";

let root: Root;
let host: HTMLDivElement;
const draw = (items: TimelineItem[], working = true) => act(async () => {
  root.render(<TimelineView items={items} loaded working={working} approval={null} agentLabel="Claude" agentId="claude-code" live />);
});
const montagens = (id: string) => spy.mounts.filter((x) => x === id).length;
const desmontagens = (id: string) => spy.unmounts.filter((x) => x === id).length;
const paragrafo = () => host.querySelector('[data-chat-item-id="a1"] p');

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  spy.mounts.length = 0;
  spy.unmounts.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe("a fala final fica no mesmo slot do corpo", () => {
  it("fala_final_nao_remonta_no_fim_do_turno: 3 pedaços de streaming e depois o fim do turno montam o Markdown uma vez", async () => {
    await draw([user, fala("Primeiro parágrafo.")]);
    const primeiro = paragrafo();
    await draw([user, fala("Primeiro parágrafo, com mais texto.")]);
    await draw([user, fala("Primeiro parágrafo, com mais texto.\n\nSegundo parágrafo.")]);
    await draw([user, fala("Primeiro parágrafo, com mais texto.\n\nSegundo parágrafo.")]);
    await draw([user, fala("Primeiro parágrafo, com mais texto.\n\nSegundo parágrafo."), end], false);

    expect(montagens("a1")).toBe(1);
    expect(desmontagens("a1")).toBe(0);
    expect(paragrafo()).toBe(primeiro);
    // A fala final continua na tela, depois do fim do turno.
    expect(host.textContent).toContain("Segundo parágrafo.");
  });

  it("turno_com_erro_mantem_a_fala_final: um turno que acabou com erro mostra a fala no mesmo slot, sem remontar", async () => {
    await draw([user, fala("Primeiro parágrafo.")]);
    const primeiro = paragrafo();
    const erro: TimelineItem = { kind: "turnEnd", id: "e", durationMs: 4000, text: "o processo caiu" };
    await draw([user, fala("Primeiro parágrafo.")]);
    await draw([user, fala("Primeiro parágrafo.")], false);
    await draw([user, fala("Primeiro parágrafo."), erro], false);

    expect(montagens("a1")).toBe(1);
    expect(desmontagens("a1")).toBe(0);
    expect(paragrafo()).toBe(primeiro);
    // Com erro o turno fica aberto para mostrar o ponto em que parou (não recolhe sozinho).
    expect(host.textContent).toContain("Primeiro parágrafo.");
  });

  it("com uma imagem chegando no 2º pedaço, o texto também não remonta (a lacuna do lote 1c)", async () => {
    await draw([user, fala("Primeiro parágrafo.")]);
    const primeiro = paragrafo();
    await draw([user, fala(`Primeiro parágrafo.\n\n${IMAGEM}`)]);
    await draw([user, fala(`Primeiro parágrafo.\n\n${IMAGEM}\n\nSegundo parágrafo.`)]);
    // Ainda em streaming, sem o fim do turno: a imagem sozinha não pode remontar o texto.
    expect(montagens("a1")).toBe(1);
    expect(paragrafo()).toBe(primeiro);
    await draw([user, fala(`Primeiro parágrafo.\n\n${IMAGEM}\n\nSegundo parágrafo.`), end], false);

    expect(montagens("a1")).toBe(1);
    expect(desmontagens("a1")).toBe(0);
    expect(paragrafo()).toBe(primeiro);
  });
});
