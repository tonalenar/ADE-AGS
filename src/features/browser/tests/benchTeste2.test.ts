// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { FAMILIES2, SEEDS2, scenario2 } from "../../../../scripts/bench-fixture/gen/scenario2.js";
import { render } from "../../../../scripts/bench-fixture/gen/render2.js";
import { testTasks2 } from "../../../../scripts/bench/tasks-teste";

type Raw = { kind: "text" | "url"; value: string } | { kind: "all"; of: Raw[] };
type Step = { click?: string; near?: string; fill?: [string, string]; select?: [string, string]; follow?: string };

const norm = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

/** O critério como o bench o confere: texto na página, pedaço no endereço. */
function holds(crit: Raw, search: string): boolean {
  if (crit.kind === "all") return crit.of.every((c) => holds(c, search));
  if (crit.kind === "url") return search.includes(crit.value);
  return norm(document.body.textContent).includes(crit.value);
}

/** O controle com esse texto (ou aria-label); com `near`, o que tem esse texto no seu bloco (o card, a linha). */
function control(text: string, near?: string): HTMLElement {
  const all = [...document.querySelectorAll<HTMLElement>("button, a, [role=tab], [role=option]")]
    .filter((node) => norm(node.textContent) === text || node.getAttribute("aria-label") === text);
  // Com um diálogo aberto, ele está na frente: o «Remover» do modal ganha do «Remover» da lista.
  const inDialog = all.filter((node) => node.closest("[role=dialog]") && !node.closest("[hidden]"));
  const pool = inDialog.length > 0 && !near ? inDialog : all;
  const found = near
    ? pool.filter((node) => norm(node.parentElement?.textContent).includes(near))
    : pool;
  if (found.length !== 1) throw new Error(`esperava 1 controle «${text}»${near ? ` perto de «${near}»` : ""}, achei ${found.length}`);
  return found[0];
}

function field(label: string): HTMLInputElement | HTMLSelectElement {
  const tag = [...document.querySelectorAll("label")].find((node) => norm(node.textContent) === label);
  const target = tag && document.getElementById(tag.htmlFor);
  if (!target) throw new Error(`campo «${label}» não achado`);
  return target as HTMLInputElement | HTMLSelectElement;
}

/** Faz o caminho certo; devolve o endereço final (um link segue para outra «página»: desenha de novo). */
function solve(s: ReturnType<typeof scenario2>, search: string): string {
  for (const step of s.solve as Step[]) {
    if (step.click) control(step.click, step.near).click();
    if (step.fill) {
      const input = field(step.fill[0]) as HTMLInputElement;
      input.value = step.fill[1];
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (step.select) {
      const select = field(step.select[0]) as HTMLSelectElement;
      select.value = step.select[1];
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (step.follow) {
      search = control(step.follow).getAttribute("href") ?? "";
      render(document, s, search);
    }
  }
  return search;
}

describe("conjunto de TESTE 2 do protocolo J2 (famílias novas)", () => {
  for (const family of FAMILIES2) {
    it(`${family}: em todas as ${SEEDS2} sementes, o critério é falso ao abrir e vale depois do caminho certo`, () => {
      for (let seed = 1; seed <= SEEDS2; seed++) {
        const s = scenario2(family, seed);
        const start = `?f=${family}&s=${seed}`;
        render(document, s, start);
        expect(holds(s.success as Raw, start), `${family} ${seed}: o critério já valia antes`).toBe(false);
        const end = solve(s, start);
        expect(holds(s.success as Raw, end), `${family} ${seed}: o critério não valeu depois do caminho certo`).toBe(true);
      }
    });
  }

  it("o caminho errado não cumpre: outra aba, outra pergunta, outro item removido", () => {
    const abas = scenario2("abas", 3);
    render(document, abas, "?f=abas&s=3");
    const other = abas.view.keys.find((key: string) => abas.view.labels[key] !== (abas.solve[0] as Step).click && key !== abas.view.keys[0]);
    if (other) control(abas.view.labels[other]).click();
    if (other) expect(holds(abas.success as Raw, "")).toBe(false);

    const conf = scenario2("confirmacao", 5);
    render(document, conf, "");
    const wrong = conf.view.items.find((name: string) => name !== (conf.solve[0] as Step).near)!;
    control(conf.view.remove, wrong).click();
    control(conf.view.yes).click();
    control(conf.view.remove, (conf.solve[0] as Step).near).click();
    control(conf.view.yes).click();
    // Removeu o certo, mas também um errado: a contagem desmente.
    expect(holds(conf.success as Raw, "")).toBe(false);
  });

  it("são 140 tarefas distintas, determinísticas e com sementes novas por --seeds", () => {
    const tasks = testTasks2();
    expect(tasks).toHaveLength(FAMILIES2.length * SEEDS2);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);
    for (const task of tasks) {
      expect(task.set).toBe("teste2");
      expect(task.url.startsWith("/gen/loja2.html?f=")).toBe(true);
      for (const fill of task.fills ?? []) expect(fill).toMatch(/^[^=]+=.+$/);
    }
    expect(scenario2("menu", 7)).toEqual(scenario2("menu", 7));
    expect(testTasks2(21, 22)).toHaveLength(FAMILIES2.length * 2);
    const langs = new Set(Array.from({ length: 20 }, (_, i) => scenario2("paginacao", i + 1).lang));
    expect(langs.size).toBeGreaterThan(1);
  });
});
