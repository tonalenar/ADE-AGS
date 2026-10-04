/** Agentes que referencian archivos con `@ruta` en el prompt. */
const AT_AGENTS = new Set(["claude-code", "gemini-cli", "opencode"]);
/** Agentes a los que se les pega la ruta tal cual (el TUI la reconoce al pegarla). */
const PLAIN_AGENTS = new Set(["codex"]);

const NEEDS_QUOTES = /\s/;

/** `@ruta`, o `@"ruta con espacios"`. */
function atPath(path: string): string {
  return NEEDS_QUOTES.test(path) || path.includes('"') ? `@"${path.replace(/"/g, '\\"')}"` : `@${path}`;
}

/** Ruta pura; con espacios, entre comillas simples. */
function plainPath(path: string): string {
  return NEEDS_QUOTES.test(path) || path.includes("'") ? `'${path.replace(/'/g, "\'")}'` : path;
}

/** Siempre entre comillas simples, sin prefijo (agentes sin sintaxis verificada). */
function quotedPath(path: string): string {
  return `'${path.replace(/'/g, "\'")}'`;
}

/**
 * Las rutas como se escriben en el prompt de cada agente: separadas por un espacio y con un
 * espacio final para seguir escribiendo. Nunca lleva saltos de línea ni Enter.
 */
export function formatPathsForAgent(agentId: string | undefined, paths: string[]): string {
  const clean = paths.map((p) => p.replace(/[\r\n]+/g, " ")).filter((p) => p.length > 0);
  if (clean.length === 0) return "";
  const fmt = agentId && AT_AGENTS.has(agentId) ? atPath : agentId && PLAIN_AGENTS.has(agentId) ? plainPath : quotedPath;
  return `${clean.map(fmt).join(" ")} `;
}
