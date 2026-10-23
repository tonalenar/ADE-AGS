/**
 * A lógica da comparação de modelos sem React nem IPC: nomes de branch, rótulos, validação do
 * diálogo, o texto que cada agente recebe e o estado de cada terminal. Tudo puro.
 */
import type { CompareEntry, EntryStatus, PickDraft, RemoveEntry } from "./types";

export const MIN_PICKS = 2;
export const MAX_PICKS = 6;

/** Nome curto do agente no nome da branch. */
const AGENT_SHORT: Record<string, string> = { "claude-code": "claude", "gemini-cli": "gemini", "kimi-code": "kimi" };

/** Texto livre → pedaço de nome de branch: minúsculas, dígitos, `-` e `.`, sem `..` nem bordas soltas. */
export function slugPart(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/** `claude-opus-high`, `codex-gpt-5.1-fast`, `opencode-openai-gpt-4.1-mini`… (até 40 caracteres). */
export function pickSlug(draft: PickDraft): string {
  const parts = [AGENT_SHORT[draft.agentId] ?? draft.agentId, draft.model?.trim() ?? "", draft.effort ?? "", draft.fast ? "fast" : ""];
  const slug = slugPart(parts.filter(Boolean).join("-")).slice(0, 40).replace(/[-.]+$/g, "").replace(/\.lock$/, "");
  return slug || "modelo";
}

/** Nomes únicos: o segundo igual vira `-2`, o terceiro `-3`. */
export function uniquePicks(slugs: string[]): string[] {
  const used = new Set<string>();
  return slugs.map((slug) => {
    let name = slug;
    for (let n = 2; used.has(name); n++) name = `${slug.slice(0, 44)}-${n}`;
    used.add(name);
    return name;
  });
}

/** O rótulo do nó e da aba: "Claude Code · opus · high". */
export function pickLabel(draft: PickDraft, agentLabel: string): string {
  return [agentLabel, draft.model?.trim() || null, draft.effort, draft.fast ? "Fast" : null].filter(Boolean).join(" · ");
}

/** Um título curto tirado do pedido: a primeira linha, até 6 palavras e 48 caracteres. */
export function defaultTitle(prompt: string): string {
  const first = prompt.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const words = first.split(/\s+/).slice(0, 6).join(" ");
  return words.length > 48 ? `${words.slice(0, 47).trimEnd()}…` : words;
}

export interface DraftInput {
  prompt: string;
  picks: PickDraft[];
  isolate: boolean;
  /** A pasta é um repositório git com commit. */
  isRepo: boolean;
  /** Os agentes instalados nesta máquina. */
  available: readonly string[];
}

/** O primeiro problema do formulário, como chave de i18n; `null` = pode iniciar. */
export function draftProblem(input: DraftInput): string | null {
  if (!input.prompt.trim()) return "compare.error.prompt";
  if (input.picks.length < MIN_PICKS) return "compare.error.few";
  if (input.picks.length > MAX_PICKS) return "compare.error.many";
  if (input.picks.some((p) => !p.agentId)) return "compare.error.agent";
  if (input.picks.some((p) => !input.available.includes(p.agentId))) return "compare.error.unavailable";
  const slugs = input.picks.map(pickSlug);
  if (new Set(slugs).size !== slugs.length) return "compare.error.duplicate";
  if (input.isolate && !input.isRepo) return "compare.error.repo";
  return null;
}

/**
 * O que cada agente recebe: uma linha de contexto (onde trabalhar, ou que é só leitura) e o
 * pedido do usuário, igual para todos. Claude Code recebe as quebras de linha; as outras TUIs
 * descartam os Enter de um pegado (ver `briefingFor`), então vai numa linha com " | ".
 */
export function promptFor(agentId: string, prompt: string, entry: Pick<CompareEntry, "cwd" | "branch" | "root">): string {
  const context = entry.root && entry.branch
    ? `[Comparação de modelos] Trabalhe somente nesta pasta: ${entry.cwd} (branch ${entry.branch}). Não faça push nem abra PR.`
    : "[Comparação de modelos] Pedido só de leitura: não edite arquivos nem rode comandos que mudem o projeto (outros agentes usam a mesma pasta).";
  const text = `${context}\n\n${prompt.trim()}`;
  if (agentId === "claude-code") return text;
  return text.split("\n").map((l) => l.trim()).filter(Boolean).join(" | ");
}

export type EntryState = "starting" | "working" | "idle" | "closed";

/** O estado de um terminal: fechado, esperando a TUI para receber o pedido, trabalhando ou parado. */
export function entryState(signals: { tabOpen: boolean; pending: boolean; active: boolean }): EntryState {
  if (!signals.tabOpen) return "closed";
  if (signals.pending) return "starting";
  return signals.active ? "working" : "idle";
}

/** Algum terminal acabou de parar (ou fechar)? Então vale medir de novo o que mudou. */
export function becameIdle(prev: Readonly<Record<string, EntryState>>, next: Readonly<Record<string, EntryState>>): boolean {
  return Object.entries(next).some(([pick, state]) => (state === "idle" || state === "closed") && prev[pick] !== undefined && prev[pick] !== state);
}

/** O resumo das mudanças de um agente: "3 arquivos · +12 −4 · 1 commit". `null` = sem medida. */
export function changeSummary(status: EntryStatus | undefined, t: (key: string, opts?: Record<string, unknown>) => string): string | null {
  if (!status || status.error) return null;
  const parts = [t("compare.changes.files", { count: status.files })];
  if (status.insertions || status.deletions) parts.push(`+${status.insertions} −${status.deletions}`);
  if (status.commits) parts.push(t("compare.changes.commits", { count: status.commits }));
  return parts.join(" · ");
}

/** Os `pick`s que saem: todos menos o mantido. */
export function picksToRemove(entries: readonly Pick<CompareEntry, "pick">[], keep: string | null): string[] {
  return entries.map((e) => e.pick).filter((p) => p !== keep);
}

/** O que a remoção perderia, por agente, para a confirmação: só quem tem trabalho. */
export function riskyRemovals(report: readonly RemoveEntry[]): RemoveEntry[] {
  return report.filter((e) => e.needsConfirmation && (e.dirty.length > 0 || e.commits.length > 0));
}

/** Travas que nenhuma confirmação desfaz (caminho estranho, branch trocada…). */
export function hardBlocked(report: readonly RemoveEntry[]): RemoveEntry[] {
  return report.filter((e) => e.blockers.length > 0 && !e.needsConfirmation);
}

/** Linhas de um diff com o tipo de cada uma, para pintar. */
export function diffLines(patch: string): { text: string; kind: "add" | "del" | "hunk" | "meta" | "ctx" }[] {
  return patch.split("\n").map((text) => {
    if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("diff --git") || text.startsWith("index ")) return { text, kind: "meta" as const };
    if (text.startsWith("@@")) return { text, kind: "hunk" as const };
    if (text.startsWith("+")) return { text, kind: "add" as const };
    if (text.startsWith("-")) return { text, kind: "del" as const };
    return { text, kind: "ctx" as const };
  });
}
