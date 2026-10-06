// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ptBR from "@/i18n/locales/pt-BR.json";

// Configura o suporte a act() do React em ambiente DOM de teste
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { MissionIndicatorState } from "./missionIndicator";
import {
  MissionTabIndicator,
  indicatorPixels,
  resetPauseInstalledForTesting,
} from "./MissionTabIndicator";


const LANGUAGES = ["pt-BR", "en", "es"] as const;
type Lang = (typeof LANGUAGES)[number];

const EXPECTED_TITLES: Record<Lang, Record<MissionIndicatorState, (count: number) => string>> = {
  "pt-BR": {
    working: (count) => (count === 1 ? "1 agente trabalhando" : `${count} agentes trabalhando`),
    waiting: () => "Esperando: nenhum agente com atividade agora",
    needsYou: () => "Precisa de você: há um agente parado esperando resposta",
    done: () => "Missão concluída",
    failed: () => "Missão encerrada sem sucesso",
    idle: () => "Missão sem atividade",
  },
  en: {
    working: (count) => (count === 1 ? "1 agent working" : `${count} agents working`),
    waiting: () => "Waiting: no agent active right now",
    needsYou: () => "Needs you: an agent is stopped waiting for a reply",
    done: () => "Mission completed",
    failed: () => "Mission ended unsuccessfully",
    idle: () => "Mission idle",
  },
  es: {
    working: (count) => (count === 1 ? "1 agente trabajando" : `${count} agentes trabajando`),
    waiting: () => "Esperando: ningún agente con actividad ahora",
    needsYou: () => "Te necesita: hay un agente detenido esperando respuesta",
    done: () => "Misión concluida",
    failed: () => "Misión terminada sin éxito",
    idle: () => "Misión sin actividad",
  },
};

function setupI18n() {
  const instance = i18next.createInstance();
  instance.use(initReactI18next).init({
    lng: "pt-BR",
    fallbackLng: "en",
    resources: {
      "pt-BR": { translation: ptBR },
      en: { translation: en },
      es: { translation: es },
    },
    interpolation: { escapeValue: false },
  });
  return instance;
}

function mockMatchMedia(reduceMotion: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const mq = {
    matches: reduceMotion,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((event: string, cb: (e: { matches: boolean }) => void) => {
      if (event === "change") listeners.add(cb);
    }),
    removeEventListener: vi.fn((event: string, cb: (e: { matches: boolean }) => void) => {
      if (event === "change") listeners.delete(cb);
    }),
    dispatchEvent: vi.fn(),
  };

  vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => {
    if (query.includes("prefers-reduced-motion")) return mq;
    return { ...mq, matches: false };
  }));

  return {
    setReduced(matches: boolean) {
      mq.matches = matches;
      listeners.forEach((l) => l({ matches }));
    },
  };
}

describe("MissionTabIndicator", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let testI18n: ReturnType<typeof setupI18n>;

  beforeEach(() => {
    resetPauseInstalledForTesting();
    document.documentElement.dataset.agsHidden = "0";
    testI18n = setupI18n();
    container = document.createElement("div");
    document.body.appendChild(container);
    mockMatchMedia(false);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const renderIndicator = (state: MissionIndicatorState, workingCount: number = 0) => {
    act(() => {
      if (!root) root = createRoot(container);
      root.render(
        <I18nextProvider i18n={testI18n}>
          <MissionTabIndicator state={state} workingCount={workingCount} />
        </I18nextProvider>,
      );
    });
    return container.querySelector<HTMLElement>(".mti");
  };

  describe("renderiza cada estado com o title correto pt-BR / en / es", () => {
    const states: MissionIndicatorState[] = ["working", "waiting", "needsYou", "done", "failed", "idle"];

    LANGUAGES.forEach((lang) => {
      describe(`idioma: ${lang}`, () => {
        beforeEach(async () => {
          await testI18n.changeLanguage(lang);
        });

        it.each(states)("renderiza estado %s com o título correto", (state) => {
          const count = state === "working" ? 2 : 0;
          const el = renderIndicator(state, count);
          expect(el).not.toBeNull();
          const expected = EXPECTED_TITLES[lang][state](count);
          expect(el?.getAttribute("title")).toBe(expected);
          expect(el?.getAttribute("aria-label")).toBe(expected);
          expect(el?.getAttribute("data-state")).toBe(state);
        });

        if (lang === "pt-BR") {
          it("suporta pluralização de 1 vs múltiplos agentes no estado working", () => {
            const elOne = renderIndicator("working", 1);
            expect(elOne?.getAttribute("title")).toBe(EXPECTED_TITLES[lang].working(1));
            expect(elOne?.querySelector(".mti-count")?.textContent).toBe("1");

            const elMany = renderIndicator("working", 4);
            expect(elMany?.getAttribute("title")).toBe(EXPECTED_TITLES[lang].working(4));
            expect(elMany?.querySelector(".mti-count")?.textContent).toBe("4");
          });
        }
      });
    });
  });

  describe("com prefers-reduced-motion (matchMedia mockado)", () => {
    it("desativa animações (data-motion='still', data-celebrate='0') sem suprimir cores e ícones", () => {
      mockMatchMedia(true);
      const el = renderIndicator("working", 2);

      expect(el?.getAttribute("data-motion")).toBe("still");
      expect(el?.getAttribute("data-celebrate")).toBe("0");

      // O contador e pixels continuam sendo desenhados corretamente
      expect(el?.querySelector(".mti-count")?.textContent).toBe("2");
      expect(el?.querySelectorAll(".mti-bot rect").length).toBeGreaterThan(0);
      expect(el?.querySelectorAll(".mti-flame rect").length).toBeGreaterThan(0);
    });

    it("mantém a troca puramente gráfica de cada estado com reduced motion", () => {
      mockMatchMedia(true);

      // working: tem propulsão/chama, bot acordado
      const workingPx = indicatorPixels("working");
      expect(workingPx.flame.length).toBeGreaterThan(0);
      expect(workingPx.badge.length).toBe(0);

      // waiting: sem chama, com olhos de sono e insígnia Z
      const waitingPx = indicatorPixels("waiting");
      expect(waitingPx.flame.length).toBe(0);
      expect(waitingPx.badge.length).toBeGreaterThan(0);

      // needsYou: tem chama e badge de exclamação
      const needsYouPx = indicatorPixels("needsYou");
      expect(needsYouPx.flame.length).toBeGreaterThan(0);
      expect(needsYouPx.badge.length).toBeGreaterThan(0);

      // done: tem chama, badge e faíscas
      const donePx = indicatorPixels("done");
      expect(donePx.flame.length).toBeGreaterThan(0);
      expect(donePx.badge.length).toBeGreaterThan(0);
      expect(donePx.sparkle.length).toBeGreaterThan(0);

      // failed e idle: sem chamas nem insígnias
      expect(indicatorPixels("failed").flame.length).toBe(0);
      expect(indicatorPixels("failed").badge.length).toBe(0);
      expect(indicatorPixels("idle").flame.length).toBe(0);
      expect(indicatorPixels("idle").badge.length).toBe(0);
    });
  });

  describe("pausa compartilhada com document.visibilityState hidden", () => {
    it("aplica data-ags-hidden='1' no elemento raiz quando hidden e '0' quando visible", () => {
      renderIndicator("working", 1);

      // Ao montar com documento visível, data-ags-hidden deve ser '0'
      expect(document.documentElement.dataset.agsHidden).toBe("0");

      // Simula ocultação da janela/aba
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      expect(document.documentElement.dataset.agsHidden).toBe("1");

      // Simula retorno à visibilidade
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      expect(document.documentElement.dataset.agsHidden).toBe("0");
    });

    it("garante um único listener compartilhado mesmo montando múltiplas abas", () => {
      const addEventListenerSpy = vi.spyOn(document, "addEventListener");
      resetPauseInstalledForTesting();

      // Monta 5 indicadores
      act(() => {
        if (!root) root = createRoot(container);
        root.render(
          <I18nextProvider i18n={testI18n}>
            <div>
              {Array.from({ length: 5 }).map((_, i) => (
                <MissionTabIndicator key={i} state="working" workingCount={i + 1} />
              ))}
            </div>
          </I18nextProvider>,
        );
      });

      const visibilityListeners = addEventListenerSpy.mock.calls.filter((call) => call[0] === "visibilitychange");
      expect(visibilityListeners.length).toBe(1);
    });
  });

  describe("sem timer por aba", () => {
    it("não registra setInterval, setTimeout ou rAF por instância", () => {
      const setIntervalSpy = vi.spyOn(window, "setInterval");
      const setTimeoutSpy = vi.spyOn(window, "setTimeout");
      const rAFSpy = vi.spyOn(window, "requestAnimationFrame");

      act(() => {
        if (!root) root = createRoot(container);
        root.render(
          <I18nextProvider i18n={testI18n}>
            <div>
              {Array.from({ length: 8 }).map((_, i) => (
                <MissionTabIndicator key={i} state={i % 2 === 0 ? "working" : "waiting"} workingCount={i} />
              ))}
            </div>
          </I18nextProvider>,
        );
      });

      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(rAFSpy).not.toHaveBeenCalled();
    });
  });

  describe("não captura clique / arraste da aba", () => {
    it("permite borbulhamento de clique e ponteiro até o container da aba sem capturar", () => {
      const onClickParent = vi.fn();
      const onPointerDownParent = vi.fn();

      act(() => {
        if (!root) root = createRoot(container);
        root.render(
          <I18nextProvider i18n={testI18n}>
            <button
              type="button"
              className="tab-button"
              onClick={onClickParent}
              onPointerDown={onPointerDownParent}
            >
              <MissionTabIndicator state="working" workingCount={2} />
              <span>Aba da Missão</span>
            </button>
          </I18nextProvider>,
        );
      });

      const indicator = container.querySelector<HTMLElement>(".mti");
      const innerRect = container.querySelector<SVGElement>("rect");
      expect(indicator).not.toBeNull();
      expect(innerRect).not.toBeNull();

      // Teste de clique no indicador
      const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
      indicator!.dispatchEvent(clickEvent);
      expect(onClickParent).toHaveBeenCalledTimes(1);
      expect(clickEvent.defaultPrevented).toBe(false);

      // Teste de pointerdown em um pixel interno (usado para arrastar aba)
      const pointerEvent = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
      innerRect!.dispatchEvent(pointerEvent);
      expect(onPointerDownParent).toHaveBeenCalledTimes(1);
      expect(pointerEvent.defaultPrevented).toBe(false);
    });
  });
});
