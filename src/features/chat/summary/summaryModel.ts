/**
 * O modelo puro do "Resumo" do painel direito (a superfície padrão, com cartões): onde a conversa roda,
 * o contexto, os conectores, as saídas e as alterações. Sem React e sem `invoke`; o que não tem fonte
 * no ADE fica como "não medido" e nunca é inventado.
 */
import type { ForgeItem } from "@/features/forge/types";

import type { TimelineItem } from "../timeline/types";

/** A tecla do Resumo no menu "Abrir uma superfície" (R de Resumo; as outras: B T F D S I A O P). */
export const SUMMARY_KEY = "r";

// ── Saídas ───────────────────────────────────────────────────────────

export interface OutputFile {
  path: string;
  name: string;
  /** `doc` (texto, markdown) ou `code`. */
  kind: "doc" | "code";
  /** O agente criou o arquivo (ferramenta de escrita) em algum momento da conversa. */
  created: boolean;
}

/** Quantas saídas aparecem antes do "Mostrar mais". */
export const OUTPUTS_SHOWN = 4;

const DOC = /\.(md|mdx|txt|rst)$/i;

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * Os arquivos que o agente criou ou editou na conversa (itens `write` e `edit` da timeline com caminho),
 * um por caminho, do mais recente para o mais antigo. Pura.
 */
export function outputsFromItems(items: TimelineItem[]): OutputFile[] {
  const byPath = new Map<string, { at: number; created: boolean }>();
  items.forEach((item, at) => {
    if (item.kind !== "tool" || !item.path || (item.tool !== "write" && item.tool !== "edit")) return;
    const before = byPath.get(item.path);
    byPath.set(item.path, { at, created: item.tool === "write" || !!before?.created });
  });
  return [...byPath.entries()]
    .sort((a, b) => b[1].at - a[1].at)
    .map(([path, v]) => ({ path, name: baseName(path), kind: DOC.test(path) ? "doc" : "code", created: v.created }));
}

/** O que a lista mostra e quantas ficam escondidas atrás do "Mostrar mais". Pura. */
export function pickOutputs(list: OutputFile[], expanded: boolean): { shown: OutputFile[]; hidden: number } {
  if (expanded || list.length <= OUTPUTS_SHOWN) return { shown: list, hidden: 0 };
  return { shown: list.slice(0, OUTPUTS_SHOWN), hidden: list.length - OUTPUTS_SHOWN };
}

// ── Alterações ───────────────────────────────────────────────────────

/** A soma das linhas do diff do worktree (o mesmo que o Diff mostra). Pura. */
export function diffTotals(files: { added: number; removed: number }[]): { files: number; added: number; removed: number } {
  return files.reduce<{ files: number; added: number; removed: number }>(
    (n, f) => ({ files: n.files + 1, added: n.added + f.added, removed: n.removed + f.removed }),
    { files: 0, added: 0, removed: 0 },
  );
}

/** Os PRs abertos DESTA branch, o número maior primeiro. Sem branch, nenhum. Pura. */
export function pullsOfBranch(pulls: ForgeItem[], branch: string | null): ForgeItem[] {
  if (!branch) return [];
  return pulls.filter((p) => p.sourceBranch === branch).sort((a, b) => b.number - a.number);
}

export type PullTone = "open" | "draft" | "merged" | "closed";

/** O estado do PR como o cartão o pinta (a bolinha). Pura. */
export function pullTone(pull: Pick<ForgeItem, "state" | "draft">): PullTone {
  if (pull.state === "merged") return "merged";
  if (pull.state === "closed") return "closed";
  return pull.draft ? "draft" : "open";
}

// ── Ambiente ─────────────────────────────────────────────────────────

/** `~/Projects` em vez de `/Users/ton/Projects`; só troca a home inteira, com fronteira de pasta. Pura. */
export function homeRelative(path: string, home: string | null): string {
  if (!home) return path;
  const clean = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = clean(path);
  const h = clean(home);
  if (p === h) return "~";
  return p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : path;
}

export interface Environment {
  /** Onde roda: neste computador ou num worktree da pasta. */
  place: "computer" | "worktree";
  folder: string;
  parent: string;
  branch: string | null;
}

/** A pasta (nome e pai), a branch e se é worktree. Pura. */
export function environmentOf(card: { cwd: string; branch: string | null; isWorktree: boolean }, home: string | null): Environment {
  const parts = card.cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  const folder = parts.pop() || card.cwd;
  return {
    place: card.isWorktree ? "worktree" : "computer",
    folder,
    parent: homeRelative(parts.join("/") || "/", home),
    branch: card.branch?.trim() || null,
  };
}

// ── Contexto e conectores ────────────────────────────────────────────

/**
 * O contexto da conversa. O ADE só sabe os tokens que o agente informa (`usage`); a janela de contexto
 * do modelo não vem de lugar nenhum, então não há porcentagem: sem tokens é "não medido". Pura.
 */
export function contextOf(tokens: number | null): { measured: boolean; tokens: number | null } {
  return tokens !== null && tokens > 0 ? { measured: true, tokens } : { measured: false, tokens: null };
}

export interface Connector {
  /** `ags` (orquestração do app) e `browser` (o navegador do ADE): as duas ferramentas do MCP do app. */
  id: "ags" | "browser";
  /** O agente desta aba recebe o MCP do app. */
  on: boolean;
}

/** Os conectores do app para a aba. A saúde da conexão não é lida: só se a aba os recebe. Pura. */
export function connectorsOf(hasMcp: boolean): Connector[] {
  return [{ id: "ags", on: hasMcp }, { id: "browser", on: hasMcp }];
}
