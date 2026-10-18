/**
 * O conjunto de TESTE do protocolo J2: 5 famílias × 20 sementes = 100 tarefas em páginas geradas
 * (`scripts/bench-fixture/gen/loja.html`), com rótulos, idioma (PT/EN/ES), ordem, obstáculos, atrasos de XHR e ícones
 * sem nome sorteados pela semente. Nenhuma regra do piloto foi ajustada nelas: é o número que vale para a meta.
 * Regra do protocolo: quem ajusta o piloto não mexe aqui depois de ver um resultado.
 *
 *   bun scripts/jev-bench.ts --real --set teste --with-expect --yes --max-real 100 --max-probes 900
 *
 * Depois de ver as falhas de uma leva de sementes, ela deixa de ser TESTE para quem ajustou o piloto: a medida seguinte
 * usa sementes novas (`--seeds 21-40`), que geram outras 100 páginas das mesmas famílias.
 */
import { FAMILIES, SEEDS, scenario, type RawCriterion } from "../bench-fixture/gen/scenario.js";
import { FAMILIES2, SEEDS2, scenario2 } from "../bench-fixture/gen/scenario2.js";
import { all, text, url, type BenchTask, type Criterion } from "./core";

function criterion(raw: RawCriterion): Criterion {
  if (raw.kind === "all") return all(...raw.of.map(criterion));
  return raw.kind === "url" ? url(raw.value) : text(raw.value);
}

const DIFFICULTY: Record<string, BenchTask["difficulty"]> = { adicionar: 3, busca: 2, filtro: 4, icone: 4, formulario: 3 };

/** As tarefas das sementes `first`..`last` (as 1..20 são a primeira leva). */
export function testTasks(first = 1, last = SEEDS): BenchTask[] {
  return FAMILIES.flatMap((family) => Array.from({ length: last - first + 1 }, (_, i) => {
    const seed = first + i;
    const s = scenario(family, seed);
    const task: BenchTask = {
      id: `T-${family}-${String(seed).padStart(2, "0")}`,
      kind: "local",
      set: "teste",
      difficulty: DIFFICULTY[family] ?? 3,
      sim: false,
      maxSteps: 8,
      title: `${family} · ${s.lang} · semente ${seed}`,
      goal: s.goal,
      url: `/gen/loja.html?f=${family}&s=${seed}`,
      ...(s.fills.length > 0 ? { fills: s.fills } : {}),
      success: criterion(s.success),
      ...(s.forbid ? { forbid: criterion(s.forbid) } : {}),
      tags: ["teste", family, s.lang],
    };
    return task;
  }));
}

export const TEST_TASKS: BenchTask[] = testTasks();

const DIFFICULTY2: Record<string, BenchTask["difficulty"]> = { abas: 2, acordeao: 3, paginacao: 3, selecao: 3, confirmacao: 3, quantidade: 3, menu: 3 };

/**
 * O conjunto de TESTE 2 (`--set teste2`): 7 famílias que o 1 não cobre — abas, perguntas que abrem (com «+» repetido),
 * paginação, escolha em lista nativa/personalizada, confirmação antes de remover, quantidade e menu. Página
 * `gen/loja2.html`; as sementes `first`..`last` (1..20 é a primeira leva).
 */
export function testTasks2(first = 1, last = SEEDS2): BenchTask[] {
  return FAMILIES2.flatMap((family) => Array.from({ length: last - first + 1 }, (_, i) => {
    const seed = first + i;
    const s = scenario2(family, seed);
    const task: BenchTask = {
      id: `T2-${family}-${String(seed).padStart(2, "0")}`,
      kind: "local",
      set: "teste2",
      difficulty: DIFFICULTY2[family] ?? 3,
      sim: false,
      maxSteps: 8,
      title: `${family} · ${s.lang} · semente ${seed}`,
      goal: s.goal,
      url: `/gen/loja2.html?f=${family}&s=${seed}`,
      ...(s.fills.length > 0 ? { fills: s.fills } : {}),
      success: criterion(s.success),
      ...(s.forbid ? { forbid: criterion(s.forbid) } : {}),
      tags: ["teste2", family, s.lang],
    };
    return task;
  }));
}
