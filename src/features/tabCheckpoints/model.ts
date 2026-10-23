/**
 * A lógica dos pontos de restauração que não precisa de tela nem de Tauri: o que vira ponto num
 * Enter, o rótulo, quem bloqueia uma restauração. Puro, para testar sem DOM.
 */
import type { Blocker, TabCheckpoint } from "./types";

/** Dois Enters na mesma aba em menos que isto contam como um envio (o reenvio do Enter, um duplo). */
export const AUTO_THROTTLE_MS = 4000;

/** Bordas de caixa e o sinal do prompt das TUIs ("│ › texto │"), que não são a mensagem. */
const BOX = /[│┃║▌▐╭╮╰╯─━┌┐└┘]/g;
const PROMPT = /^\s*(?:[>›❯»▶$#%]+\s*)+/;

/** O texto da caixa de entrada sem as bordas nem o sinal do prompt. */
export function cleanTyped(text: string): string {
  return text.replace(BOX, " ").replace(PROMPT, "").replace(/\s+/g, " ").trim();
}

export interface AutoCapture {
  message: string;
  author: "pessoa" | "ade";
}

/**
 * Este Enter vira ponto? `pasted` = o que o app colou ali agora (missão, navegador, trecho); senão é a
 * pessoa, e o rótulo sai da caixa de entrada. Um Enter numa caixa vazia, ou logo depois de outro na
 * mesma aba, não vira.
 */
export function autoCaptureFor(input: { pasted: string | null; typed: string; lastAt?: number; at: number }): AutoCapture | null {
  if (input.lastAt !== undefined && input.at - input.lastAt < AUTO_THROTTLE_MS) return null;
  if (input.pasted && input.pasted.trim()) return { message: input.pasted, author: "ade" };
  const typed = cleanTyped(input.typed);
  if (typed.length < 2) return null;
  return { message: typed, author: "pessoa" };
}

/** A chave de i18n de quem mandou a mensagem. */
export function authorKey(author: string): string {
  switch (author) {
    case "pessoa": return "tabCheckpoints.author.person";
    case "peer": return "tabCheckpoints.author.peer";
    case "chat": return "tabCheckpoints.author.chat";
    case "rotina": return "tabCheckpoints.author.routine";
    default: return "tabCheckpoints.author.app";
  }
}

/** A chave de i18n do tipo do ponto. */
export function kindKey(kind: string): string {
  if (kind === "manual") return "tabCheckpoints.kind.manual";
  if (kind === "safety") return "tabCheckpoints.kind.safety";
  return "tabCheckpoints.kind.message";
}

export interface BlockerLine {
  kind: "tab" | "task";
  /** O título da aba (ou o id da tarefa). */
  name: string;
  dir: string;
}

/** Quem bloqueia, com o título da aba quando ela é conhecida nesta janela. */
export function describeBlockers(blockers: Blocker[], tabs: { id: string; title: string; agentLabel?: string }[]): BlockerLine[] {
  return blockers.map((b) => {
    if (b.kind !== "tab") return { kind: "task", name: b.id, dir: b.dir };
    const tab = tabs.find((t) => t.id === b.id);
    return { kind: "tab", name: tab?.title || tab?.agentLabel || b.id, dir: b.dir };
  });
}

/** O ponto de segurança mais novo depois de `checkpoint` (o que desfaz uma restauração para ele). */
export function undoFor(list: TabCheckpoint[], checkpoint: TabCheckpoint): TabCheckpoint | null {
  return list.filter((c) => c.kind === "safety" && c.seq > checkpoint.seq).sort((a, b) => b.seq - a.seq)[0] ?? null;
}

/** Abas que sumiram da lista entre dois estados do store (uma aba fechada). */
export function closedTabs(prev: readonly { id: string }[], next: readonly { id: string }[]): string[] {
  const alive = new Set(next.map((t) => t.id));
  return prev.filter((t) => !alive.has(t.id)).map((t) => t.id);
}

/** Uma linha do patch e a classe da cor dela (as mesmas da revisão de missão). */
export function diffTone(line: string): "add" | "del" | "hunk" | "file" | "plain" {
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "del";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("diff ")) return "file";
  return "plain";
}
