import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ptBR from "@/i18n/locales/pt-BR.json";
import { MissionTabIndicator, indicatorPixels } from "../MissionTabIndicator";
import type { MissionIndicatorState } from "../missionIndicator";

let currentLang: "pt-BR" | "en" | "es" = "pt-BR";
const locales: Record<string, Record<string, string>> = {
  "pt-BR": ptBR,
  en,
  es,
};

function translate(key: string, opts?: { count?: number }) {
  const dict = locales[currentLang] ?? locales.en!;
  if (opts?.count !== undefined) {
    const pluralKey = opts.count === 1 ? `${key}_one` : `${key}_other`;
    if (dict[pluralKey]) {
      return dict[pluralKey].replace("{{count}}", String(opts.count));
    }
  }
  return dict[key] ?? key;
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translate }),
}));

function withReducedMotion(reduce: boolean) {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({
      matches: reduce && query.includes("prefers-reduced-motion"),
      addEventListener() {},
      removeEventListener() {},
    }),
  });
}

afterEach(() => {
  currentLang = "pt-BR";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MissionTabIndicator", () => {
  it("anima el estado «trabajando» y muestra el contador y el título accesible", () => {
    withReducedMotion(false);
    currentLang = "es";
    const html = renderToString(<MissionTabIndicator state="working" workingCount={3} />);
    expect(html).toContain('data-motion="on"');
    expect(html).toContain('data-state="working"');
    expect(html).toContain('title="3 agentes trabajando"');
    expect(html).toContain('class="mti-count"');
  });

  it("con prefers-reduced-motion no anima: solo cambia el icono", () => {
    withReducedMotion(true);
    currentLang = "es";
    const html = renderToString(<MissionTabIndicator state="needsYou" workingCount={0} />);
    expect(html).toContain('data-motion="still"');
    expect(html).toContain('data-celebrate="0"');
    expect(html).toContain('title="Te necesita: hay un agente detenido esperando respuesta"');
  });

  it("una misión ya concluida al montar queda como sello estático (sin celebrar)", () => {
    withReducedMotion(false);
    currentLang = "pt-BR";
    const html = renderToString(<MissionTabIndicator state="done" workingCount={0} />);
    expect(html).toContain('data-celebrate="0"');
    expect(html).toContain('title="Missão concluída"');
  });

  it("cada estado dibuja lo suyo: ojos propios, Z al esperar, X de !, chispas al concluir", () => {
    expect(indicatorPixels("working").eyes).toBe("block");
    expect(indicatorPixels("waiting").eyes).toBe("closed");
    expect(indicatorPixels("failed").eyes).toBe("x");
    expect(indicatorPixels("done").eyes).toBe("chevron");
    expect(indicatorPixels("idle").eyes).toBe("block");
    expect(indicatorPixels("waiting").badge.length).toBeGreaterThan(0);
    expect(indicatorPixels("failed").badge).toHaveLength(0);
    expect(indicatorPixels("idle").badge).toHaveLength(0);
    expect(indicatorPixels("done").sparkle.length).toBeGreaterThan(0);
    expect(indicatorPixels("needsYou").badge.length).toBeGreaterThan(0);
  });

  it("usa el sprite compartido: la insignia queda a la derecha del robot de 16 columnas", () => {
    withReducedMotion(false);
    const html = renderToString(<MissionTabIndicator state="needsYou" workingCount={0} />);
    expect(html).toContain("ags-leg");
    expect(html).toContain("ags-arm");
    expect(Math.min(...indicatorPixels("done").badge.map((p) => p.x))).toBeGreaterThanOrEqual(16);
  });

  describe("títulos acessíveis localizados em pt-BR, en e es", () => {
    const states: Array<{
      state: MissionIndicatorState;
      count: number;
      expected: Record<"pt-BR" | "en" | "es", string>;
    }> = [
      {
        state: "working",
        count: 1,
        expected: {
          "pt-BR": "1 agente trabalhando",
          en: "1 agent working",
          es: "1 agente trabajando",
        },
      },
      {
        state: "working",
        count: 3,
        expected: {
          "pt-BR": "3 agentes trabalhando",
          en: "3 agents working",
          es: "3 agentes trabajando",
        },
      },
      {
        state: "waiting",
        count: 0,
        expected: {
          "pt-BR": "Esperando: nenhum agente com atividade agora",
          en: "Waiting: no agent active right now",
          es: "Esperando: ningún agente con actividad ahora",
        },
      },
      {
        state: "needsYou",
        count: 0,
        expected: {
          "pt-BR": "Precisa de você: há um agente parado esperando resposta",
          en: "Needs you: an agent is stopped waiting for a reply",
          es: "Te necesita: hay un agente detenido esperando respuesta",
        },
      },
      {
        state: "done",
        count: 0,
        expected: {
          "pt-BR": "Missão concluída",
          en: "Mission completed",
          es: "Misión concluida",
        },
      },
      {
        state: "failed",
        count: 0,
        expected: {
          "pt-BR": "Missão encerrada sem sucesso",
          en: "Mission ended unsuccessfully",
          es: "Misión terminada sin éxito",
        },
      },
      {
        state: "idle",
        count: 0,
        expected: {
          "pt-BR": "Missão sem atividade",
          en: "Mission idle",
          es: "Misión sin actividad",
        },
      },
    ];

    (["pt-BR", "en", "es"] as const).forEach((lang) => {
      it(`renderiza cada estado com o título e aria-label corretos em ${lang}`, () => {
        currentLang = lang;
        for (const { state, count, expected } of states) {
          const html = renderToString(<MissionTabIndicator state={state} workingCount={count} />);
          expect(html).toContain(`title="${expected[lang]}"`);
          expect(html).toContain(`aria-label="${expected[lang]}"`);
          expect(html).toContain(`data-state="${state}"`);
        }
      });
    });
  });

  describe("prefers-reduced-motion", () => {
    it("desativa keyframes mantendo data-motion='still' e cores/ícones fiéis por estado", () => {
      withReducedMotion(true);

      const htmlWorking = renderToString(<MissionTabIndicator state="working" workingCount={2} />);
      expect(htmlWorking).toContain('data-motion="still"');
      expect(htmlWorking).toContain('class="mti-count"');
      expect(htmlWorking).toContain('>2</span>');

      const htmlWaiting = renderToString(<MissionTabIndicator state="waiting" workingCount={0} />);
      expect(htmlWaiting).toContain('data-motion="still"');

      // Verifica CSS para reduced motion
      const css = readFileSync(resolve(__dirname, "../mission-tab-indicator.css"), "utf-8");
      expect(css).toContain("@media (prefers-reduced-motion: reduce) { .mti * { animation: none !important; } }");
    });
  });

  describe("pausa compartilhada com janela oculta (hidden)", () => {
    it("pausa todas as animações via regra CSS :root[data-ags-hidden='1']", () => {
      const css = readFileSync(resolve(__dirname, "../mission-tab-indicator.css"), "utf-8");
      expect(css).toContain(':root[data-ags-hidden="1"] .mti * { animation-play-state: paused !important; }');
    });
  });

  describe("sem timer por aba", () => {
    it("montar múltiplos indicadores não instancia setInterval, setTimeout ou rAF por aba", () => {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const rAFSpy = typeof requestAnimationFrame === "function" ? vi.spyOn(globalThis, "requestAnimationFrame" as never) : null;

      for (let i = 0; i < 10; i++) {
        renderToString(<MissionTabIndicator state="working" workingCount={i + 1} />);
      }

      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      if (rAFSpy) expect(rAFSpy).not.toHaveBeenCalled();
    });
  });

  describe("não captura clique nem interfere no arraste da aba", () => {
    it("não declara manipuladores de clique/arraste e preserva borbulhamento", () => {
      const html = renderToString(
        <button type="button" className="tab-chip">
          <MissionTabIndicator state="working" workingCount={2} />
          <span>Missão 1</span>
        </button>,
      );

      expect(html).toContain('class="tab-chip"');
      expect(html).toContain('class="mti"');
      expect(html).not.toContain("pointer-events: none");
      expect(html).not.toContain("onclick=");
      expect(html).not.toContain("onpointerdown=");
      expect(html).not.toContain("draggable=");
    });
  });
});

