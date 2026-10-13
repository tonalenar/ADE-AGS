// Compara os braços dos testes A/B (títulos "[AB:<grupo>:<braço>] ...") lendo o banco da app SÓ para leitura.
// Uso: node scripts/ab-report.mjs [grupo] [--db <caminho>]
//
// Por missão: estado, se foi entregue (aplicada), duração, leituras de memória pelos agentes e classe de falha.
// Por braço: quantas, taxa de entrega, duração mediana e leituras. Com poucas missões por braço isso é só
// um indício, não prova: o relatório diz quantas há.
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const dbAt = args.includes("--db") ? args[args.indexOf("--db") + 1] : join(homedir(), ".ags", "data.db");
const only = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--db")?.toLowerCase();

const MARK = /^\s*\[AB:([a-z0-9_-]{1,32}):([a-z0-9_-]{1,32})\]/i;
const db = new DatabaseSync(dbAt, { readOnly: true });

const hasUsage = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_usage'").get();
const usage = (id) => hasUsage
  ? db.prepare("SELECT action, COUNT(*) n, COALESCE(SUM(hits),0) hits FROM memory_usage WHERE mission_id = ? GROUP BY action").all(id)
  : [];

const rows = db.prepare("SELECT id, title, status, started_at, ended_at, applied_at, failure_class, is_test FROM missions ORDER BY created_at").all()
  .map((m) => ({ ...m, ab: MARK.exec(m.title) }))
  .filter((m) => m.ab && (!only || m.ab[1].toLowerCase() === only));

if (rows.length === 0) {
  console.log("Nenhuma missão com o marcador [AB:<grupo>:<braço>] no título" + (only ? ` (grupo ${only})` : "") + ".");
  process.exit(0);
}

const median = (list) => {
  const v = list.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const fmt = (s) => (s === null ? "—" : s >= 3600 ? `${(s / 3600).toFixed(1)}h` : s >= 60 ? `${Math.round(s / 60)}min` : `${Math.round(s)}s`);

const per = rows.map((m) => {
  const u = Object.fromEntries(usage(m.id).map((r) => [r.action, r]));
  return {
    group: m.ab[1].toLowerCase(),
    arm: m.ab[2].toLowerCase(),
    title: m.title.replace(MARK, "").trim().slice(0, 40),
    status: m.status,
    delivered: m.status === "done" && m.applied_at != null,
    seconds: m.started_at && m.ended_at ? m.ended_at - m.started_at : null,
    searches: u.search?.n ?? 0,
    opens: u.open?.n ?? 0,
    hits: u.search?.hits ?? 0,
    failure: m.failure_class ?? "",
  };
});

console.log("\nMissões");
for (const r of per) {
  console.log(`${r.group.padEnd(10)} ${r.arm.padEnd(13)} ${r.status.padEnd(22)} ${r.delivered ? "entregue" : "—       "} ${fmt(r.seconds).padStart(6)}  buscas ${r.searches} aberturas ${r.opens}  ${r.failure}  ${r.title}`);
}

const key = (r) => `${r.group}/${r.arm}`;
const arms = new Map();
for (const r of per) arms.set(key(r), [...(arms.get(key(r)) ?? []), r]);

console.log("\nPor braço");
for (const [name, list] of arms) {
  const delivered = list.filter((r) => r.delivered).length;
  const reads = list.reduce((s, r) => s + r.searches + r.opens, 0);
  console.log(`${name.padEnd(24)} n=${list.length}  entregues ${delivered}/${list.length}  duração mediana ${fmt(median(list.map((r) => r.seconds)))}  leituras de memória ${reads}`);
}

const offWithReads = per.filter((r) => r.arm === "sem-memoria" && r.searches + r.opens > 0);
if (offWithReads.length) console.log(`\nAtenção: ${offWithReads.length} missão(ões) do braço sem-memoria ainda leram memória pelo CLI; o braço ficou contaminado.`);
const small = [...arms.values()].some((l) => l.length < 3);
if (small) console.log("\nCom menos de 3 missões por braço isto é só um indício. Meça mais pares antes de concluir.");
