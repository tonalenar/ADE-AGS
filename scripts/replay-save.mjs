// Salva a fixture que `ags replay stop` devolveu na pasta dos testes por replay.
//   ags replay stop --tab <id> | node scripts/replay-save.mjs [nome]
// Não sobrescreve um arquivo que já existe. Depois, escreva os checkpoints à mão
// (docs/ade-ags/REPLAY_TESTES.md).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "features", "terminal", "tests", "fixtures", "replay");

const input = readFileSync(0, "utf8").trim();
let fixture;
try {
  fixture = JSON.parse(input);
} catch {
  console.error("A entrada não é JSON. Use: ags replay stop --tab <id> | node scripts/replay-save.mjs [nome]");
  process.exit(2);
}
if (fixture.error) {
  console.error(`O ags recusou: ${fixture.error}`);
  process.exit(1);
}
if (fixture.format !== "ade-replay" || fixture.version !== 1 || !Array.isArray(fixture.chunks)) {
  console.error("Isto não é uma fixture ade-replay v1.");
  process.exit(1);
}
const name = (process.argv[2] ?? fixture.id).replace(/\.json$/, "");
if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
  console.error(`Nome inválido: "${name}" (use minúsculas, números e hífen).`);
  process.exit(2);
}
fixture.id = name;
const path = join(DIR, `${name}.json`);
if (existsSync(path)) {
  console.error(`Já existe: ${path}`);
  process.exit(1);
}
writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`Salvo: ${path} (${fixture.chunks.length} pedaços). Agora escreva os checkpoints e rode REPLAY_TIMELINE=1 bunx vitest run src/features/terminal/tests/replay.test.ts`);
