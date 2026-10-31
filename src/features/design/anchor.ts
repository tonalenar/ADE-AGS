import type { Box } from "./camera";

/**
 * Comentários ancorados. A âncora é o seletor CSS do elemento dentro da prancheta (até 1024 caracteres
 * e 10 segmentos `a > b`) e um ponto relativo (0–1) dentro dele; sem elemento, o ponto é relativo à
 * prancheta inteira. Puro.
 */
export const ANCHOR_MAX_CHARS = 1024;
export const ANCHOR_MAX_SEGMENTS = 10;
export const SEND_LIMITS = { label: 120, selectedText: 1800, request: 2000 } as const;

/** Corta o seletor nos 10 últimos segmentos e em 1024 caracteres; vazio vira `null`. */
export function clampAnchor(selector: string | null | undefined): string | null {
  const parts = (selector ?? "").split(">").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const joined = parts.slice(-ANCHOR_MAX_SEGMENTS).join(" > ");
  return joined.length > ANCHOR_MAX_CHARS ? joined.slice(joined.length - ANCHOR_MAX_CHARS).replace(/^[^>]*>\s*/, "") || null : joined;
}

const unit = (v: number) => Math.round(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)) * 10000) / 10000;

/** O ponto (px, py) relativo à caixa, preso entre 0 e 1 e com 4 casas. */
export function relativePoint(px: number, py: number, box: Pick<Box, "x" | "y" | "w" | "h">): { x: number; y: number } {
  return { x: unit(box.w > 0 ? (px - box.x) / box.w : 0), y: unit(box.h > 0 ? (py - box.y) / box.h : 0) };
}

export interface AnchoredComment {
  id: string;
  artboardId: string;
  anchor: string | null;
  pointX?: number | null;
  pointY?: number | null;
}

/**
 * Onde desenhar o pino, em px de MUNDO. `elementRect` é a caixa do elemento dentro da prancheta (px
 * da prancheta), quando o iframe a informou; sem ela (prancheta descarregada, elemento sumiu) o ponto
 * vale relativo à prancheta inteira.
 */
export function pinPosition(c: AnchoredComment, board: Box, elementRect: Box | null): { x: number; y: number } {
  const fx = c.pointX ?? 0.5;
  const fy = c.pointY ?? 0.5;
  const base = c.anchor && elementRect ? elementRect : { x: 0, y: 0, w: board.w, h: board.h };
  return {
    x: board.x + Math.min(board.w, Math.max(0, base.x + fx * base.w)),
    y: board.y + Math.min(board.h, Math.max(0, base.y + fy * base.h)),
  };
}

export interface ThreadItem { id: string; parentId: string | null; createdAt: number; resolved: boolean }

/** Os fios: cada comentário raiz com as respostas (por `parentId`) em ordem de criação. Resposta órfã vira raiz. */
export function threadsOf<T extends ThreadItem>(comments: T[]): Array<{ root: T; replies: T[] }> {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const sorted = [...comments].sort((a, b) => a.createdAt - b.createdAt);
  const roots = sorted.filter((c) => !c.parentId || !byId.has(c.parentId));
  // Uma resposta de resposta pertence ao fio da raiz.
  const rootOf = (c: T): string => {
    let cur = c;
    const seen = new Set<string>();
    while (cur.parentId && byId.has(cur.parentId) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.parentId)!;
    }
    return cur.id;
  };
  return roots.map((root) => ({ root, replies: sorted.filter((c) => c !== root && rootOf(c) === root.id) }));
}

export interface SendPayload { label: string; selectedText: string; request: string }

const cut = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** `{rótulo ≤120, texto selecionado ≤1800, pedido ≤2000}`, com espaços normalizados. */
export function sendPayload(label: string, selectedText: string, request: string): SendPayload {
  return { label: cut(label, SEND_LIMITS.label), selectedText: cut(selectedText, SEND_LIMITS.selectedText), request: cut(request, SEND_LIMITS.request) };
}

/** O texto que chega ao agente (no composer da conversa ou no terminal do dono). */
export function formatSendText(p: SendPayload, ctx: { designTitle: string; designId: string; boardTitle: string; boardId: string; anchor: string | null }): string {
  const lines = [`[Design "${ctx.designTitle}" (${ctx.designId}) › prancheta "${ctx.boardTitle}" (${ctx.boardId})${p.label ? ` › ${p.label}` : ""}]`];
  if (ctx.anchor) lines.push(`Elemento: ${ctx.anchor}`);
  if (p.selectedText) lines.push(`Trecho: "${p.selectedText}"`);
  if (p.request) lines.push(`Pedido: ${p.request}`);
  lines.push("Atualize com 'ags design artboard update'.");
  return lines.join("\n");
}

/** O seletor do pai (Esc sobe um nível): tira o último segmento; sem pai dentro da prancheta, `null`. */
export function parentSelector(selector: string): string | null {
  const parts = selector.split(">").map((x) => x.trim()).filter(Boolean);
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).join(" > ");
}
