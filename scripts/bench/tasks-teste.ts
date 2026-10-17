/**
 * O conjunto de TESTE do protocolo J2: 5 famílias × 20 sementes = 100 tarefas em páginas geradas
 * (`scripts/bench-fixture/gen/loja.html`), com rótulos, idioma (PT/EN/ES), ordem, obstáculos, atrasos de XHR e ícones
 * sem nome sorteados pela semente. Nenhuma regra do piloto foi ajustada nelas: é o número que vale para a meta.
 * Regra do protocolo: quem ajusta o piloto não mexe aqui depois de ver um resultado.
 *
 *   bun scripts/jev-bench.ts --real --set teste --with-expect --yes --max-real 100 --max-probes 900
 */
import { FAMILIES, SEEDS, scenario, type RawCriterion } from "../bench-fixture/gen/scenario.js";
import { all, text, url, type BenchTask, type Criterion } from "./core";

function criterion(raw: RawCriterion): Criterion {
  if (raw.kind === "all") return all(...raw.of.map(criterion));
  return raw.kind === "url" ? url(raw.value) : text(raw.value);
}

const DIFFICULTY: Record<string, BenchTask["difficulty"]> = { adicionar: 3, busca: 2, filtro: 4, icone: 4, formulario: 3 };

export const TEST_TASKS: BenchTask[] = FAMILIES.flatMap((family) =>
  Array.from({ length: SEEDS }, (_, i) => {
    const seed = i + 1;
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
  }),
);
