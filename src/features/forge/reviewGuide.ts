/**
 * O guia de revisão de um PR, do lado da tela: o passo a passo pelas paradas, o diff de um
 * arquivo com os números de linha, o link para o arquivo no host e o texto com que se
 * pergunta a um agente sobre uma parada. Tudo puro, para testar sem DOM.
 *
 * O guia em si sai do backend (`src-tauri/src/forge/guide.rs`).
 */
import type { ForgeItem, GuideStop, LineRange, ReviewGuide } from "./types";

/** As TUIs que geram o guia sem terminal e somente leitura. Espelha
 *  `runs::oneshot::READ_ONLY_AGENTS`, na mesma ordem. */
export const GUIDE_AGENTS = ["claude-code", "codex", "gemini-cli", "opencode"] as const;

// ── passo a passo ─────────────────────────────────────────────────

export interface StepperState {
  current: number;
  /** Ids das paradas já vistas. */
  visited: string[];
}

function clamp(index: number, guide: ReviewGuide): number {
  return Math.max(0, Math.min(index, guide.stops.length - 1));
}

function visit(visited: string[], id: string | undefined): string[] {
  return !id || visited.includes(id) ? visited : [...visited, id];
}

/** Começa na primeira parada ainda não vista (ou na primeira, se já viu todas). A que
 *  aparece conta como vista. Ids que o guia não tem mais são descartados. */
export function initStepper(guide: ReviewGuide, visited: string[]): StepperState {
  const known = visited.filter((id) => guide.stops.some((s) => s.id === id));
  const firstNew = guide.stops.findIndex((s) => !known.includes(s.id));
  const current = firstNew === -1 ? 0 : firstNew;
  return { current, visited: visit(known, guide.stops[current]?.id) };
}

export function goTo(state: StepperState, guide: ReviewGuide, index: number): StepperState {
  if (guide.stops.length === 0) return state;
  const current = clamp(index, guide);
  return { current, visited: visit(state.visited, guide.stops[current]?.id) };
}

export const nextStop = (state: StepperState, guide: ReviewGuide) => goTo(state, guide, state.current + 1);
export const prevStop = (state: StepperState, guide: ReviewGuide) => goTo(state, guide, state.current - 1);

/** Que tecla move o passo a passo. Com modificador não é dele (atalhos do app). */
export function stepperKey(e: { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }): "next" | "prev" | null {
  if (e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.key === "ArrowRight" || e.key === "j" || e.key === "n") return "next";
  if (e.key === "ArrowLeft" || e.key === "k" || e.key === "p") return "prev";
  return null;
}

/** Se o evento veio de um campo de texto: aí a seta é do cursor, não do guia. */
export function isEditableTarget(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  return el.isContentEditable === true || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

// ── visitadas (localStorage, por PR e commit) ────────────────────────

export const visitedKey = (repo: string, number: number, headSha: string) =>
  `cc-review-guide-visited:${repo}#${number}@${headSha}`;

/** Lê a lista de visitadas, tolerando lixo. */
export function parseVisited(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function loadVisited(key: string): string[] {
  try {
    return parseVisited(localStorage.getItem(key));
  } catch {
    return [];
  }
}

export function saveVisited(key: string, visited: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(visited));
  } catch {
    // Sem armazenamento (modo privado): só não lembra.
  }
}

// ── diff ──────────────────────────────────────────────────────────

export interface DiffLine {
  kind: "hunk" | "add" | "del" | "ctx" | "meta";
  text: string;
  /** Número na versão nova (`add`/`ctx`). */
  newLine: number | null;
  /** Número na versão velha (`del`/`ctx`). */
  oldLine: number | null;
}

/** Um diff unificado em linhas, com os números de cada lado. */
export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldN = 0;
  let newN = 0;
  const rows = patch.replace(/\r\n/g, "\n").split("\n");
  // A quebra final do patch não é uma linha.
  if (rows.length > 1 && rows[rows.length - 1] === "") rows.pop();
  for (const text of rows) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldN = Number(hunk[1]);
      newN = Number(hunk[2]);
      out.push({ kind: "hunk", text, newLine: null, oldLine: null });
    } else if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("\\") || text.startsWith("diff ") || text.startsWith("index ")) {
      out.push({ kind: "meta", text, newLine: null, oldLine: null });
    } else if (text.startsWith("+")) {
      out.push({ kind: "add", text, newLine: newN++, oldLine: null });
    } else if (text.startsWith("-")) {
      out.push({ kind: "del", text, newLine: null, oldLine: oldN++ });
    } else {
      out.push({ kind: "ctx", text, newLine: newN++, oldLine: oldN++ });
    }
  }
  return out;
}

export const inRange = (line: DiffLine, range: LineRange | undefined) =>
  !!range && line.newLine !== null && line.newLine >= range.start && line.newLine <= range.end;

// ── links ─────────────────────────────────────────────────────────

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Onde ver um arquivo do PR no host. GitHub: a aba de arquivos, ancorada no arquivo
 * (`#diff-<sha256 do caminho>`) e nas linhas (`R10-R20`). GitLab: a aba de mudanças.
 */
export async function hostFileUrl(webUrl: string, path: string, lines?: LineRange): Promise<string> {
  const base = webUrl.replace(/\/+$/, "");
  if (base.includes("/-/merge_requests/")) return `${base}/diffs`;
  const anchor = `diff-${await sha256Hex(path)}`;
  const range = lines ? (lines.end > lines.start ? `R${lines.start}-R${lines.end}` : `R${lines.start}`) : "";
  return `${base}/files#${anchor}${range}`;
}

// ── perguntar a um agente ───────────────────────────────────────────

/** Onde abre o agente que responde: o worktree do PR, se estiver aberto. */
export function askWorkdir(
  workspaces: { cwd: string; branch: string | null }[],
  item: Pick<ForgeItem, "number" | "sourceBranch">,
  cwd: string,
): string {
  const found = workspaces.find((w) => w.branch && (w.branch === item.sourceBranch || w.branch === `pr/${item.number}`));
  return found?.cwd ?? cwd;
}

const MAX_EXCERPT = 4_000;

/**
 * O texto que vai pré-preenchido (sem enviar) na aba nova: o PR, a parada, os arquivos e o
 * trecho. Em inglês, como tudo o que o modelo lê (ver `agentPrompt.ts`); a pessoa completa
 * com a pergunta dela no fim.
 */
export function askPrompt(input: {
  item: Pick<ForgeItem, "number" | "title" | "webUrl" | "sourceBranch" | "targetBranch">;
  stop: GuideStop;
  index: number;
  total: number;
  summary: string;
  headSha: string;
}): string {
  const { item, stop } = input;
  const lines: string[] = [
    `I'm reviewing pull request #${item.number} "${item.title}" (${item.webUrl}).`,
  ];
  if (item.sourceBranch && item.targetBranch) lines.push(`Branches: ${item.sourceBranch} → ${item.targetBranch}, head ${input.headSha.slice(0, 12)}.`);
  lines.push(
    `A review guide split it into ${input.total} stops. PR summary: ${input.summary}`,
    "",
    `## Stop ${input.index + 1} of ${input.total}: ${stop.title}`,
    "",
    `Why it matters: ${stop.why}`,
    "",
    "Files:",
    ...stop.files.map((f) => `- ${f.path}${f.lines ? ` (lines ${f.lines.start}-${f.lines.end})` : ""}`),
  );
  if (stop.lookClosely.length) lines.push("", "Look closely at:", ...stop.lookClosely.map((l) => `- ${l}`));
  if (stop.excerpt) {
    const excerpt = stop.excerpt.length > MAX_EXCERPT ? `${stop.excerpt.slice(0, MAX_EXCERPT)}\n[… truncated]` : stop.excerpt;
    lines.push("", "Excerpt from the diff:", "```diff", excerpt, "```");
  }
  if (stop.questions?.length) lines.push("", "Open questions from the guide:", ...stop.questions.map((q) => `- ${q}`));
  lines.push(
    "",
    "Read the code of this stop (the local checkout may not be at the PR head; prefer the PR diff, e.g. via ADE AGS's git_pr_files tool).",
    "Don't change files, push, or comment on the PR unless I ask.",
    "",
    "My question: ",
  );
  return lines.join("\n");
}
