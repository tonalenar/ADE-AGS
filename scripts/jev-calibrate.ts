/**
 * Calibra os limites do piloto (plano v2, 4.5): lê os relatórios do benchmark REAL e, se houver, uma CÓPIA do
 * `data.db` (para o `decision_shadow_log`), e escreve o Markdown da curva acerto × limite.
 *
 *   npx tsx scripts/jev-calibrate.ts [--bench docs/ade-ags/bench] [--db caminho/da/copia/data.db] [--out docs/ade-ags/bench/calibracao-limites.md]
 *
 * Não custa consulta ao Jev. O `--db` é aberto SÓ para leitura: copie o `data.db` (e o `-wal`) antes, nunca aponte para o do app.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MIN_BOX_CONFIDENCE, MIN_FOUND, MIN_GOAL_DONE, MIN_PROBABILITY } from "../src/features/browser/jevPilot";
import { corpusFrom, dedupeRuns, logStats, renderCalibration, type CalRun, type LogRow } from "./bench/calibrate";

const argv = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : undefined;
};

const dir = value("bench") ?? "docs/ade-ags/bench";
const runs: CalRun[] = [];
for (const file of readdirSync(dir).filter((f) => /real.*\.json$/.test(f) && !/causas/.test(f))) {
  const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as { runs?: CalRun[] };
  runs.push(...(parsed.runs ?? []));
}
const unique = dedupeRuns(runs);

function logOf(db: DatabaseSync, point: string): LogRow[] {
  const rows = db.prepare("SELECT provider_decision, probability, latency_ms, error, input_tokens FROM decision_shadow_log WHERE point = ? ORDER BY ts").all(point) as Record<string, unknown>[];
  return rows.map((r) => ({
    decision: (r.provider_decision as string | null) ?? null,
    probability: (r.probability as number | null) ?? null,
    latencyMs: (r.latency_ms as number | null) ?? null,
    error: (r.error as string | null) ?? null,
    inputTokens: (r.input_tokens as number | null) ?? null,
  }));
}

let log = null;
let vision = null;
const dbPath = value("db");
if (dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  log = logStats(logOf(db, "browser_step"));
  vision = logStats(logOf(db, "browser_vision"));
  db.close();
}

const markdown = renderCalibration({
  runs: unique.length,
  corpus: corpusFrom(unique),
  log,
  vision,
  limits: { minProbability: MIN_PROBABILITY, minGoalDone: MIN_GOAL_DONE, minFound: MIN_FOUND, minBox: MIN_BOX_CONFIDENCE },
});
const out = value("out");
if (out) writeFileSync(out, `${markdown}\n`);
else console.log(markdown);
