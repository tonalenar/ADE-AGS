// Regiões geradas (ponto 22 do deepseek-harness): o índice de comandos da CLI e a lista de tools do MCP
// saem do código, entre marcadores BEGIN/END GENERATED, para "comando novo atualiza a skill" não depender
// de memória.
//
// Fontes (lidas como texto, sem compilar nada):
// - `src-tauri/src/bin/cli.rs` (a USAGE) e `src-tauri/src/ipc/commands/dispatch.rs` (os grupos);
// - `src-tauri/src/ipc/mcp.rs` e `src-tauri/src/forge/tools.rs` (as tools).
// Regiões:
// - `mcp-tools-help` em `bin/cli.rs` (a constante que a ajuda imprime depois da USAGE);
// - `mcp-tools` na skill e em `docs/agentes/CLI_MCP.md`;
// - `cli-commands` na skill.
//
// Uso: `bun scripts/check-catalogs.ts` confere (sai com 1 se algo está velho);
//      `bun scripts/check-catalogs.ts --write` regenera.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = "src-tauri/src/bin/cli.rs";
const DISPATCH = "src-tauri/src/ipc/commands/dispatch.rs";
const MCP = "src-tauri/src/ipc/mcp.rs";
const GIT = "src-tauri/src/forge/tools.rs";
const SKILL = "skills/ags-orchestrator/SKILL.md";
const DOC = "docs/agentes/CLI_MCP.md";

/** O bloco `const NAME: &[...] = &[ ... ];` de um arquivo Rust. */
export function rustBlock(src: string, name: string): string {
  const start = src.search(new RegExp(`const ${name}: &\\[`));
  if (start < 0) throw new Error(`não achei a tabela ${name}`);
  const end = src.indexOf("\n];", start);
  if (end < 0) throw new Error(`a tabela ${name} não fecha`);
  return src.slice(start, end);
}

const names = (block: string, re: RegExp) => [...block.matchAll(re)].map((m) => m[1]!);

export interface ToolFamily {
  family: string;
  /** O nome da família na ajuda da CLI (PT-BR); a skill fica em inglês. */
  pt: string;
  who: string;
  tools: string[];
}

export function mcpTools(mcp: string, git: string): ToolFamily[] {
  const field = /name: "([a-z_]+)"/g;
  const orchestration = names(rustBlock(mcp, "ORCHESTRATION_TOOLS"), field);
  const ask = mcp.match(/pub const ASK_TOOL: &str = "([a-z_]+)";/)?.[1];
  const approve = mcp.match(/pub const TOOL_NAME: &str = "([a-z_]+)";/)?.[1];
  if (!ask || !approve) throw new Error("não achei ASK_TOOL/TOOL_NAME em mcp.rs");
  return [
    { family: "Browser", pt: "Navegador", who: "every session", tools: names(rustBlock(mcp, "BROWSER_TOOLS"), field) },
    { family: "Fleet orchestration", pt: "Orquestração da frota", who: "every session (read-only roles get only the Read power)", tools: orchestration.filter((t) => !t.startsWith("memory_")) },
    { family: "Fleet memory", pt: "Memória da frota", who: "fleet tasks only (`--task`)", tools: orchestration.filter((t) => t.startsWith("memory_")) },
    { family: "Git account", pt: "Conta de git", who: "every session", tools: names(rustBlock(git, "GIT_TOOLS"), field) },
    { family: "Peers and team", pt: "Pares e time", who: "interactive tabs (`--tab`)", tools: names(rustBlock(mcp, "PEER_TOOLS"), /\("([a-z_]+)", "/g) },
    { family: "Chat-mode conversations", pt: "Conversas do modo chat", who: "interactive sessions (`--cwd`)", tools: names(rustBlock(mcp, "CHAT_TOOLS"), field) },
    { family: "Designs", pt: "Pranchetas", who: "interactive sessions (`--cwd`)", tools: names(rustBlock(mcp, "DESIGN_TOOLS"), field) },
    { family: "Questions to the person", pt: "Perguntas à pessoa", who: "every session (team members get `refused`, see above)", tools: [ask] },
    { family: "Permission", pt: "Permissão", who: "fleet tasks only (`--task`)", tools: [approve] },
  ].filter((f) => f.tools.length > 0);
}

/** O texto da USAGE (o literal `const USAGE: &str = "\` … `";`), com os escapes do Rust desfeitos. */
export function usageText(cli: string): string {
  const start = cli.indexOf('const USAGE: &str = "\\\n');
  if (start < 0) throw new Error("não achei a USAGE em cli.rs");
  const body = cli.slice(start + 'const USAGE: &str = "\\\n'.length);
  const end = body.indexOf('\n";');
  return body.slice(0, end).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** Os grupos que a CLI conhece: os do despachador e os atalhos de uma palavra. */
export function commandGroups(dispatch: string, cli: string): Set<string> {
  const groups = new Set<string>(["mcp", "test", "ai-memory-bridge"]);
  for (const m of dispatch.matchAll(/^\s*"([a-z][a-z-]*)\.[a-z.-]+"\s*(\||=>)/gm)) groups.add(m[1]!);
  for (const m of cli.matchAll(/^\s*"([a-z-]+)" => Some\("/gm)) groups.add(m[1]!);
  return groups;
}

export interface CommandSection {
  section: string;
  commands: string[];
}

/** As seções da USAGE (títulos em maiúsculas) e os comandos de cada uma (`grupo ação`). */
export function cliCommands(usage: string, groups: Set<string>): CommandSection[] {
  const out: CommandSection[] = [];
  let current: CommandSection | undefined;
  for (const line of usage.split("\n")) {
    // Título: palavras em maiúsculas no começo da linha, seguidas do fim, de " (" ou de " —".
    const title = line.match(/^([A-ZÀ-Ý][A-ZÀ-Ý0-9,]*(?: [A-ZÀ-Ý0-9,]+)*)(?:$| \(| —)/);
    if (title) {
      current = { section: title[1]!.trim(), commands: [] };
      out.push(current);
      continue;
    }
    const cmd = line.match(/^ {2}([a-z][a-z-]*)(?: ([a-z][a-z-]*))?(?=\s|$)/);
    if (!current || !cmd || !groups.has(cmd[1]!)) continue;
    const name = cmd[2] ? `${cmd[1]} ${cmd[2]}` : cmd[1]!;
    if (!current.commands.includes(name)) current.commands.push(name);
  }
  return out.filter((s) => s.commands.length > 0);
}

const MD_NOTE = "<!-- Gerado por `bun run gen:catalogs` a partir do código; não edite à mão. -->";

export function mcpToolsMarkdown(families: ToolFamily[]): string {
  const rows = families.map((f) => `| ${f.family} | ${f.who} | ${f.tools.map((t) => `\`${t}\``).join(", ")} |`);
  return [MD_NOTE, "| Family | Who sees it | Tools |", "|---|---|---|", ...rows].join("\n");
}

export function cliCommandsMarkdown(sections: CommandSection[]): string {
  const rows = sections.map((s) => `| ${s.section} | ${s.commands.map((c) => `\`${c}\``).join(", ")} |`);
  return [MD_NOTE, "| Section of `ags --help` | Commands |", "|---|---|", ...rows].join("\n");
}

/** A constante Rust que a ajuda da CLI imprime depois da USAGE, com linhas de até ~100 colunas. */
export function mcpToolsRust(families: ToolFamily[]): string {
  const lines = ["FERRAMENTAS MCP (o que `ags mcp` oferece; gerado de ipc/mcp.rs e forge/tools.rs)"];
  for (const f of families) {
    const label = `  ${f.pt}:`;
    let line = label;
    for (const tool of f.tools) {
      const piece = `${line === label ? " " : ", "}${tool}`;
      if (line.length + piece.length > 100) {
        lines.push(`${line},`);
        line = `    ${tool}`;
      } else {
        line += piece;
      }
    }
    lines.push(line);
  }
  const body = lines.map((l) => l.replace(/\\/g, "\\\\").replace(/"/g, '\\"')).join("\n");
  return `const MCP_TOOLS_HELP: &str = "\\\n${body}\n";`;
}

export interface Marker {
  begin: string;
  end: string;
}

const markers = (name: string, comment: "md" | "rust"): Marker =>
  comment === "md"
    ? { begin: `<!-- BEGIN GENERATED: ${name} -->`, end: `<!-- END GENERATED: ${name} -->` }
    : { begin: `// BEGIN GENERATED: ${name} (bun run gen:catalogs)`, end: `// END GENERATED: ${name}` };

/** Troca o miolo da região. Erra se os marcadores não estão lá (exatamente uma vez cada). */
export function replaceRegion(text: string, marker: Marker, content: string): string {
  const begin = text.indexOf(marker.begin);
  const end = text.indexOf(marker.end);
  if (begin < 0 || end < begin || text.indexOf(marker.begin, begin + 1) >= 0) {
    throw new Error(`marcadores ausentes ou repetidos: ${marker.begin}`);
  }
  return `${text.slice(0, begin + marker.begin.length)}\n${content}\n${text.slice(end)}`;
}

export const SOURCES = [CLI, DISPATCH, MCP, GIT, SKILL, DOC];

export function generate(files: Record<string, string>): Record<string, string> {
  const families = mcpTools(files[MCP]!, files[GIT]!);
  const sections = cliCommands(usageText(files[CLI]!), commandGroups(files[DISPATCH]!, files[CLI]!));
  const out = { ...files };
  out[CLI] = replaceRegion(out[CLI]!, markers("mcp-tools-help", "rust"), mcpToolsRust(families));
  for (const path of [SKILL, DOC]) out[path] = replaceRegion(out[path]!, markers("mcp-tools", "md"), mcpToolsMarkdown(families));
  out[SKILL] = replaceRegion(out[SKILL]!, markers("cli-commands", "md"), cliCommandsMarkdown(sections));
  return out;
}

if (import.meta.main) {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
  const paths = SOURCES;
  const files = Object.fromEntries(paths.map((p) => [p, read(p)]));
  const fresh = generate(files);
  const stale = paths.filter((p) => fresh[p] !== files[p]);
  if (process.argv.includes("--write")) {
    for (const p of stale) writeFileSync(join(ROOT, p), fresh[p]!);
    console.log(stale.length ? `Regenerado: ${stale.join(", ")}` : "Regiões geradas já estavam em dia.");
  } else if (stale.length) {
    console.error(`Regiões geradas velhas em: ${stale.join(", ")}.\nRode \`bun run gen:catalogs\` e commite o resultado.`);
    process.exit(1);
  } else {
    console.log("Regiões geradas em dia.");
  }
}
