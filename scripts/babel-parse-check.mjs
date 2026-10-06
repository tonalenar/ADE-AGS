// Parsea todo src/ con el mismo parser que usa Vite en desarrollo (@vitejs/plugin-react -> Babel).
// `tsc` acepta cosas que Babel rechaza (p. ej. `export { x }` de un binding que no se declara bien
// antes del import): el app muestra el overlay de error del Vite y `vitest`/`tsc` no se enteran.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";

const failures = [];
let count = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules") walk(path);
    } else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) {
      count += 1;
      try {
        parse(readFileSync(path, "utf8"), { sourceType: "module", plugins: ["typescript", "jsx"] });
      } catch (e) {
        failures.push(`${path}: ${e.message}`);
      }
    }
  }
};
walk(process.argv[2] ?? "src");
if (failures.length > 0) {
  console.error(`Babel no pudo parsear ${failures.length} archivo(s):\n` + failures.join("\n"));
  process.exit(1);
}
console.log(`Babel parseó ${count} archivos sin errores.`);
