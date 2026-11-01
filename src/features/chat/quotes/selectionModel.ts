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
}

const quotable = (node: Node | null): boolean => {
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  return !!element?.closest("[data-quotable]");
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
  return { text, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } };
}

/** O atalho de «Comentar» para quem seleciona pelo teclado: ⌥⌘M no macOS, Ctrl+Shift+M nos outros. Pura. */
export function matchCommentShortcut(e: Pick<KeyboardEvent, "key" | "altKey" | "metaKey" | "ctrlKey" | "shiftKey">, mac: boolean): boolean {
  if (e.key.toLowerCase() !== "m") return false;
  return mac ? e.altKey && e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;
}
