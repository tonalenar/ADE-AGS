import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, o?: { count?: number }) => `${k}:${o?.count ?? ""}` }),
}));

import { MissionTabIndicator, indicatorPixels } from "../MissionTabIndicator";

function withReducedMotion(reduce: boolean) {
  vi.stubGlobal("window", { matchMedia: () => ({ matches: reduce, addEventListener() {}, removeEventListener() {} }) });
}

afterEach(() => vi.unstubAllGlobals());

describe("MissionTabIndicator", () => {
  it("anima el estado «trabajando» y muestra el contador y el título accesible", () => {
    withReducedMotion(false);
    const html = renderToString(<MissionTabIndicator state="working" workingCount={3} />);
    expect(html).toContain('data-motion="on"');
    expect(html).toContain('data-state="working"');
    expect(html).toContain('title="missions.indicator.working:3"');
    expect(html).toContain('class="mti-count"');
  });

  it("con prefers-reduced-motion no anima: solo cambia el icono", () => {
    withReducedMotion(true);
    const html = renderToString(<MissionTabIndicator state="needsYou" workingCount={0} />);
    expect(html).toContain('data-motion="still"');
    expect(html).toContain('data-celebrate="0"');
  });

  it("una misión ya concluida al montar queda como sello estático (sin celebrar)", () => {
    withReducedMotion(false);
    const html = renderToString(<MissionTabIndicator state="done" workingCount={0} />);
    expect(html).toContain('data-celebrate="0"');
  });

  it("cada estado dibuja lo suyo: llama solo si trabaja/necesita/concluida, Z al esperar, chispas al concluir", () => {
    expect(indicatorPixels("working").flame.length).toBeGreaterThan(0);
    expect(indicatorPixels("waiting").flame).toHaveLength(0);
    expect(indicatorPixels("waiting").badge.length).toBeGreaterThan(0);
    expect(indicatorPixels("failed").badge).toHaveLength(0);
    expect(indicatorPixels("idle").flame).toHaveLength(0);
    expect(indicatorPixels("done").sparkle.length).toBeGreaterThan(0);
    expect(indicatorPixels("needsYou").badge.length).toBeGreaterThan(0);
  });
});
