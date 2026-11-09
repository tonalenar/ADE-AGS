/**
 * A seleção de texto que pode virar um comentário: dentro de uma fala da conversa (a do agente, de um colega ou da
 * pessoa, marcadas com `data-quotable`) e dentro da lista da conversa. Puro no que recebe (a seleção do navegador e o
 * contêiner), para testar sem tela.
 */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface SelectionLike {
  isCollapsed: boolean;
  rangeCount: number;
  anchorNode: Node | null;
  focusNode: Node | null;
  toString: () => string;
  getRangeAt: (index: number) => { getBoundingClientRect: () => Rect | DOMRect };
}

export interface SelectionTarget {
  text: string;
  rect: Rect;
  /** Origem opcional de uma área citável, como o caminho do arquivo no Diff. */
  source?: string;
  /** Item da timeline onde a seleção começou e terminou; só vale dentro da mesma mensagem. */
  originItemId?: string;
}

const quotable = (node: Node | null): boolean => {
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  return !!element?.closest("[data-quotable]");
};

const quoteSource = (node: Node | null): string | undefined => {
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  return element?.closest("[data-quote-source]")?.getAttribute("data-quote-source")?.trim() || undefined;
};

const quoteItemId = (node: Node | null): string | undefined => {
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  return element?.closest("[data-chat-item-id]")?.getAttribute("data-chat-item-id")?.trim() || undefined;
};

/** O trecho selecionado e onde ele está na tela, ou `null` se a seleção não é de uma fala desta lista. */
export function selectionTarget(selection: SelectionLike | null, container: Element | null): SelectionTarget | null {
  if (!selection || !container || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode || !container.contains(anchorNode) || !container.contains(focusNode)) return null;
  if (!quotable(anchorNode) || !quotable(focusNode)) return null;
  const r = selection.getRangeAt(0).getBoundingClientRect();
  const anchorSource = quoteSource(anchorNode);
  const focusSource = quoteSource(focusNode);
  const source = anchorSource && anchorSource === focusSource ? anchorSource : undefined;
  const anchorItemId = quoteItemId(anchorNode);
  const focusItemId = quoteItemId(focusNode);
  const originItemId = anchorItemId && anchorItemId === focusItemId ? anchorItemId : undefined;
  return { text, source, ...(originItemId ? { originItemId } : {}), rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } };
}

/** O atalho de «Comentar» para quem seleciona pelo teclado: ⌥⌘M no macOS, Ctrl+Shift+M nos outros. Pura. */
export function matchCommentShortcut(e: Pick<KeyboardEvent, "key" | "altKey" | "metaKey" | "ctrlKey" | "shiftKey">, mac: boolean): boolean {
  if (e.key.toLowerCase() !== "m") return false;
  return mac ? e.altKey && e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;
}
