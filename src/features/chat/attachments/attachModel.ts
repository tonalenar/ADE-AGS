/**
 * O modelo puro dos anexos do composer do modo chat: o que é um anexo, os limites, juntar sem repetir,
 * o bloco `[Anexos]` que vai no texto da mensagem (o fallback de todos os motores: o caminho nunca se
 * perde em silêncio) e o caminho de volta, para mostrar as miniaturas ao reabrir a conversa. Sem React
 * e sem `invoke`.
 */
import { formatPathsForAgent } from "@/features/terminal/formatPathsForAgent";

/** Quantos anexos cabem numa mensagem. */
export const MAX_ATTACHMENTS = 10;
/** Uma imagem colada ou lida para a prévia (o mesmo teto do backend, `attachments.rs`). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Um arquivo qualquer: o agente o lê pelo caminho, o app não o carrega; o teto evita anexar um disco inteiro por engano. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** A soma dos tamanhos de uma mensagem. */
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export type AttachmentKind = "image" | "file" | "folder";

export interface Attachment {
  /** O caminho (único por mensagem). */
  id: string;
  path: string;
  name: string;
  kind: AttachmentKind;
  mime: string | null;
  /** Bytes; `null` = pasta (não se soma). */
  size: number | null;
  /** A prévia de uma imagem (URL de dados ou `blob:`), quando já se tem. */
  preview: string | null;
  /** Foi salva numa pasta temporária do app (imagem colada): some depois. */
  temp: boolean;
  /** A leitura do caminho falhou (não entra na mensagem; vira aviso). */
  error?: string;
}

export interface Rejected {
  name: string;
  reason: "tooMany" | "tooBig" | "totalTooBig" | "error";
  detail?: string;
}

/** Junta anexos novos aos que já há: sem repetir o mesmo caminho e dentro dos limites. Pura. */
export function addAttachments(current: Attachment[], incoming: Attachment[]): { list: Attachment[]; rejected: Rejected[] } {
  const list = [...current];
  const rejected: Rejected[] = [];
  let total = list.reduce((n, a) => n + (a.size ?? 0), 0);
  for (const a of incoming) {
    if (a.error) { rejected.push({ name: a.name, reason: "error", detail: a.error }); continue; }
    if (list.some((x) => x.path === a.path)) continue;
    if (list.length >= MAX_ATTACHMENTS) { rejected.push({ name: a.name, reason: "tooMany" }); continue; }
    const size = a.size ?? 0;
    if (size > (a.kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES)) { rejected.push({ name: a.name, reason: "tooBig" }); continue; }
    if (total + size > MAX_TOTAL_BYTES) { rejected.push({ name: a.name, reason: "totalTooBig" }); continue; }
    total += size;
    list.push(a);
  }
  return { list, rejected };
}

// ── O bloco no texto ─────────────────────────────────────────────────

const HEADER = "[Anexos]";
const KIND_WORD: Record<AttachmentKind, string> = { image: "imagem", file: "arquivo", folder: "pasta" };
const KIND_OF_WORD: Record<string, AttachmentKind> = { imagem: "image", arquivo: "file", pasta: "folder" };
const LINE = /^- (imagem|arquivo|pasta) \| (.*?) \| (\d+|-) \| (.+)$/;

/** O bloco com o caminho de cada anexo, que vai no fim do texto da mensagem. Vazio sem anexos. Pura. */
export function attachmentBlock(list: Attachment[]): string {
  if (list.length === 0) return "";
  const lines = list.map((a) => `- ${KIND_WORD[a.kind]} | ${a.name.replace(/\|/g, "¦").replace(/[\r\n]+/g, " ")} | ${a.size ?? "-"} | ${a.path}`);
  return [HEADER, ...lines].join("\n");
}

/** O texto da pessoa com o bloco no fim (ou só o bloco, se não há texto). Pura. */
export function withAttachmentBlock(text: string, list: Attachment[]): string {
  const block = attachmentBlock(list);
  if (!block) return text;
  return text.trim() ? `${text.trimEnd()}\n\n${block}` : block;
}

export interface ParsedAttachment {
  kind: AttachmentKind;
  name: string;
  size: number | null;
  path: string;
}

/**
 * Separa o texto da pessoa do bloco `[Anexos]` do fim da mensagem (a mensagem guardada pelo motor). Só
 * vale se o bloco inteiro for o nosso, do cabeçalho ao fim; senão o texto passa intacto. Pura.
 */
export function splitAttachmentBlock(text: string): { text: string; attachments: ParsedAttachment[] } {
  const at = text.lastIndexOf(`\n${HEADER}\n`);
  const start = text.startsWith(`${HEADER}\n`) ? 0 : at >= 0 ? at + 1 : -1;
  if (start < 0) return { text, attachments: [] };
  const lines = text.slice(start + HEADER.length + 1).split("\n");
  const parsed: ParsedAttachment[] = [];
  for (const line of lines) {
    const m = LINE.exec(line);
    if (!m) return { text, attachments: [] };
    parsed.push({ kind: KIND_OF_WORD[m[1]!]!, name: m[2]!, size: m[3] === "-" ? null : Number(m[3]), path: m[4]! });
  }
  return parsed.length > 0 ? { text: text.slice(0, start).trimEnd(), attachments: parsed } : { text, attachments: [] };
}

/** Os caminhos de uma conversa em TUI, como o terminal já os escreve no prompt do agente. Pura. */
export function mentionsFor(agentId: string | undefined, list: { path: string }[]): string {
  return formatPathsForAgent(agentId, list.map((a) => a.path));
}

// ── Tamanho, envio e altura ──────────────────────────────────────────

export function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Dá para enviar: há texto ou anexo, e nada está desligado nem ocupado. Pura. */
export function canSubmit(text: string, attachments: number, disabled: boolean, busy: boolean): boolean {
  return (text.trim().length > 0 || attachments > 0) && !disabled && !busy;
}

/** O bloco do composer cresce até esta altura (40% da janela, com um piso) e rola por dentro. Pura. */
export function composerMaxHeight(windowHeight: number): number {
  return Math.max(160, Math.floor(windowHeight * 0.4));
}
