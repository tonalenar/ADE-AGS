/**
 * Seleção citável (modelo puro alinhado ao `selectionActions.ts` e `assistantTextSelection.ts` do T3 Code):
 * só vale dentro de áreas `[data-quotable]` pertencentes ao contêiner, fora de botões/elementos ocultos
 * ou com `user-select: none`, e quando ao menos parte da seleção está visível na viewport/recortes.
 */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export type SelectionActionPoint = { x: number; y: number };

export const SELECTION_MULTI_CLICK_INTERVAL_MS = 500;

const EXCLUDED_SELECTOR =
  'button, input, textarea, select, [role="button"], [contenteditable], [hidden], [aria-hidden="true"], script, style, template, noscript, svg';

export interface SelectionLike {
  isCollapsed: boolean;
  rangeCount: number;
  anchorNode: Node | null;
  focusNode: Node | null;
  toString: () => string;
  getRangeAt: (index: number) => {
    getBoundingClientRect: () => Rect | DOMRect;
    getClientRects?: () => DOMRectList | ArrayLike<Rect | DOMRect>;
    cloneRange?: () => Range;
  };
}

/** Referência ao trecho original na DOM para ancorar o popover de comentário ao lado da seleção. */
export interface QuoteSourceAnchor {
  source: Element;
  range: Range;
  rect: Rect;
}

export interface SelectionTarget {
  text: string;
  rect: Rect;
  /** Origem opcional de uma área citável, como o caminho do arquivo no Diff. */
  source?: string;
  /** Item da timeline onde a seleção começou e terminou; só vale dentro da mesma mensagem. */
  originItemId?: string;
  /** Elemento citável `[data-quotable]` onde a seleção foi feita. */
  sourceElement?: Element;
  /** Intervalo clonado da seleção para reposicionar o editor enquanto a fonte existir. */
  range?: Range;
}

const asElement = (node: Node | null): Element | null =>
  node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;

const quotable = (node: Node | null): boolean => !!asElement(node)?.closest("[data-quotable]");

const isExcluded = (node: Node | null): boolean => {
  const el = asElement(node);
  if (!el) return false;
  if (el.closest(EXCLUDED_SELECTOR)) return true;
  const view = el.ownerDocument?.defaultView;
  return !!view && view.getComputedStyle(el).userSelect === "none";
};

const quoteSource = (node: Node | null): string | undefined =>
  asElement(node)?.closest("[data-quote-source]")?.getAttribute("data-quote-source")?.trim() || undefined;

const quoteItemId = (node: Node | null): string | undefined =>
  asElement(node)?.closest("[data-chat-item-id]")?.getAttribute("data-chat-item-id")?.trim() || undefined;

type ClipRect = { left: number; top: number; right: number; bottom: number };

/** Verifica se um retângulo tem interseção visível com todos os recortes (viewport + ancestrais com overflow). Pura. */
export function isSelectionRectVisible(rect: ClipRect, clips: readonly ClipRect[]): boolean {
  let { left, top, right, bottom } = rect;
  for (const clip of clips) {
    left = Math.max(left, clip.left);
    top = Math.max(top, clip.top);
    right = Math.min(right, clip.right);
    bottom = Math.min(bottom, clip.bottom);
  }
  return right > left && bottom > top;
}

/**
 * Restringe o retângulo da seleção à largura da mensagem fonte (ex.: blocos de código ou tabelas
 * com rolagem horizontal, onde o texto citado pode terminar além da borda visível). Pura.
 */
export function clampAnchorRectToSource(rect: Rect, sourceBounds: Rect): Rect {
  const left = Math.min(Math.max(rect.left, sourceBounds.left), sourceBounds.right);
  const right = Math.max(Math.min(rect.right, sourceBounds.right), left);
  return {
    left,
    top: rect.top,
    right,
    bottom: rect.bottom,
    width: right - left,
    height: rect.height,
  };
}

/**
 * Calcula as coordenadas do popover de comentário alinhado à borda direita (`align="end"`)
 * abaixo da seleção (`preferSide="bottom"`) ou acima do chip (`preferSide="top"`), espelhando o T3 Code. Pura.
 */
export function citationCommentCoordinates(
  anchor: Rect | null,
  width: number,
  height: number,
  preferSide: "bottom" | "top",
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const margin = 8;
  const sideOffset = 6;
  if (!anchor || (anchor.width === 0 && anchor.height === 0)) {
    return {
      left: Math.max(margin, (viewport.width - width) / 2),
      top: Math.max(margin, Math.min(140, viewport.height - height - margin)),
    };
  }
  const left = Math.max(margin, Math.min(anchor.right - width, viewport.width - width - margin));
  const fitsBottom = anchor.bottom + sideOffset + height <= viewport.height - margin;
  const fitsTop = anchor.top - sideOffset - height >= margin;
  const rawTop =
    preferSide === "bottom"
      ? fitsBottom || !fitsTop
        ? anchor.bottom + sideOffset
        : anchor.top - sideOffset - height
      : fitsTop || !fitsBottom
        ? anchor.top - sideOffset - height
        : anchor.bottom + sideOffset;
  const top = Math.max(margin, Math.min(rawTop, viewport.height - height - margin));
  return { left, top };
}

/** Calcula a posição do botão flutuante logo abaixo do fim da seleção, limitada ao contêiner e à janela. Pura. */
export function resolveSelectionActionPosition(options: {
  bounds: { left: number; top: number; width: number; height: number };
  selectionRect: { right: number; bottom: number } | null;
  pointer: SelectionActionPoint | null;
  viewport: { width: number; height: number };
}): SelectionActionPoint {
  const { bounds, selectionRect, pointer, viewport } = options;
  const preferred = {
    x: pointer?.x ?? selectionRect?.right ?? bounds.left + bounds.width - 140,
    y: selectionRect ? selectionRect.bottom + 4 : (pointer?.y ?? bounds.top + 12),
  };
  return {
    x: Math.max(
      8,
      Math.min(Math.max(bounds.left, preferred.x), bounds.left + bounds.width, viewport.width - 8),
    ),
    y: Math.max(
      8,
      Math.min(Math.max(bounds.top, preferred.y), bounds.top + bounds.height, viewport.height - 8),
    ),
  };
}

function isRangeVisibleInContainer(
  container: Element,
  anchorNode: Node,
  focusNode: Node,
  rects: Rect[],
): boolean {
  const bounds = container.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return true;
  if (rects.every((r) => r.width <= 0 && r.height <= 0)) return true;
  const clips: ClipRect[] = [{ left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom }];
  const view = container.ownerDocument?.defaultView;
  if (view) {
    clips.push({ left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight });
    for (const endpoint of [anchorNode, focusNode]) {
      for (let el = asElement(endpoint); el && el !== container; el = el.parentElement) {
        const style = view.getComputedStyle(el);
        const clipX = style.overflowX !== "visible";
        const clipY = style.overflowY !== "visible";
        if (!clipX && !clipY) continue;
        const r = el.getBoundingClientRect();
        const left = r.left + el.clientLeft;
        const top = r.top + el.clientTop;
        clips.push({
          left: clipX ? left : -Infinity,
          right: clipX ? left + el.clientWidth : Infinity,
          top: clipY ? top : -Infinity,
          bottom: clipY ? top + el.clientHeight : Infinity,
        });
      }
    }
  }
  return rects.some((line) => line.width > 0 && line.height > 0 && isSelectionRectVisible(line, clips));
}

/** O trecho selecionado e o retângulo final da seleção, ou `null` se inválido/oculto/excluído. */
export function selectionTarget(selection: SelectionLike | null, container: Element | null): SelectionTarget | null {
  if (!selection || !container || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode || !container.contains(anchorNode) || !container.contains(focusNode)) return null;
  if (!quotable(anchorNode) || !quotable(focusNode)) return null;
  if (isExcluded(anchorNode) || isExcluded(focusNode)) return null;

  const range = selection.getRangeAt(0);
  const clientRects = range.getClientRects?.();
  const rectList: Rect[] = [];
  if (clientRects) {
    for (let i = 0; i < clientRects.length; i++) {
      const cr = clientRects[i]!;
      rectList.push({ left: cr.left, top: cr.top, right: cr.right, bottom: cr.bottom, width: cr.width, height: cr.height });
    }
  }
  const bounding = range.getBoundingClientRect();
  const fallbackRect: Rect = {
    left: bounding.left,
    top: bounding.top,
    right: bounding.right,
    bottom: bounding.bottom,
    width: bounding.width,
    height: bounding.height,
  };
  const visibleRects = rectList.filter((r) => r.width > 0 && r.height > 0);
  const lastRect = visibleRects[visibleRects.length - 1] ?? rectList[rectList.length - 1] ?? fallbackRect;
  if (!isRangeVisibleInContainer(container, anchorNode, focusNode, visibleRects.length > 0 ? visibleRects : [fallbackRect])) {
    return null;
  }

  const anchorSource = quoteSource(anchorNode);
  const focusSource = quoteSource(focusNode);
  const source = anchorSource && anchorSource === focusSource ? anchorSource : undefined;
  const anchorItemId = quoteItemId(anchorNode);
  const focusItemId = quoteItemId(focusNode);
  const originItemId = anchorItemId && anchorItemId === focusItemId ? anchorItemId : undefined;
  const sourceElement = asElement(anchorNode)?.closest("[data-quotable]") ?? undefined;
  const clonedRange =
    typeof range.cloneRange === "function" ? range.cloneRange() : (range as unknown as Range);
  return {
    text,
    source,
    ...(originItemId ? { originItemId } : {}),
    ...(sourceElement ? { sourceElement } : {}),
    range: clonedRange,
    rect: lastRect,
  };
}

/** Observa gestos de seleção, rolagem, cliques externos, foco e Esc (espelha `observeSelectionActions` do T3 Code). */
export function observeSelectionActions({
  element,
  getActionElement,
  onSelection,
  onDismiss,
}: {
  element: Element;
  getActionElement?: () => HTMLElement | null;
  onSelection: (pointer: SelectionActionPoint | null) => void;
  onDismiss: (reason: "interaction" | "cancel") => void;
}) {
  const doc = element.ownerDocument;
  const view = doc.defaultView ?? window;
  let pointerDown = false;
  let gestureActive = false;
  let dismissed = false;
  let pointer: SelectionActionPoint | null = null;
  let timer: number | null = null;
  let frame: number | null = null;

  const isActionTarget = (target: EventTarget | null) =>
    target !== null && (getActionElement?.()?.contains(target as Node) ?? false);

  const cancelPending = () => {
    if (timer !== null) view.clearTimeout(timer);
    if (frame !== null) view.cancelAnimationFrame(frame);
    timer = frame = null;
  };
  const cancel = () => {
    cancelPending();
    pointerDown = gestureActive = false;
    pointer = null;
    dismissed = true;
  };
  const dismiss = () => {
    cancel();
    onDismiss("cancel");
  };
  const onContextMenu = () => {
    cancel();
    onDismiss("interaction");
  };
  const schedule = (delay: number) => {
    cancelPending();
    if (delay === 0) {
      onSelection(pointer);
      return;
    }
    timer = view.setTimeout(() => {
      timer = null;
      frame = view.requestAnimationFrame(() => {
        frame = null;
        onSelection(pointer);
      });
    }, delay);
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.isPrimary === false) return;
    if (isActionTarget(event.target)) {
      cancel();
      return;
    }
    cancelPending();
    pointerDown = (event.button ?? 0) === 0;
    const inside = element.contains(event.target as Node);
    gestureActive = false;
    dismissed = true;
    pointer = null;
    if (inside) onDismiss("interaction");
    else if (getActionElement?.()) onDismiss("cancel");
  };
  const onSelectionStart = (event: Event) => {
    const pe = event as PointerEvent;
    if (pe.isPrimary === false) return;
    const target = event.target as Element | null;
    if (target?.closest("button, [role=button]")) return;
    gestureActive = (pe.button ?? 0) === 0 && !event.defaultPrevented;
    dismissed = !gestureActive;
  };
  const onPointerUp = (event: PointerEvent) => {
    if (event.isPrimary !== false && (event.button ?? 0) === 0) pointerDown = false;
  };
  const onMouseUp = (event: MouseEvent) => {
    if ((event.button ?? 0) !== 0) return;
    pointerDown = false;
    if (!gestureActive) return;
    gestureActive = false;
    pointer = { x: event.clientX, y: event.clientY };
    schedule(event.detail >= 2 ? SELECTION_MULTI_CLICK_INTERVAL_MS : 0);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (isActionTarget(event.target) && event.key !== "Escape") return;
    if (event.key === "Escape") {
      dismiss();
    } else if (!pointerDown) {
      cancelPending();
      gestureActive = false;
      pointer = null;
      dismissed = false;
    }
  };
  const onFocusIn = (event: FocusEvent) => {
    if (isActionTarget(event.target)) cancel();
    else if (!pointerDown && getActionElement?.()) dismiss();
  };
  const onScroll = () => {
    cancelPending();
    if (!pointerDown) {
      pointer = null;
      dismissed = true;
    }
    onDismiss("cancel");
  };

  doc.addEventListener("pointerdown", onPointerDown as EventListener, true);
  element.addEventListener("pointerdown", onSelectionStart);
  view.addEventListener("pointerup", onPointerUp as EventListener);
  view.addEventListener("mouseup", onMouseUp as EventListener);
  view.addEventListener("pointercancel", dismiss);
  doc.addEventListener("keydown", onKeyDown);
  doc.addEventListener("focusin", onFocusIn);
  element.addEventListener("contextmenu", onContextMenu, true);
  element.addEventListener("scroll", onScroll, true);
  view.addEventListener("blur", dismiss);
  view.addEventListener("resize", dismiss);

  return {
    cancel,
    selectionChanged() {
      if (isActionTarget(doc.activeElement)) return;
      if (pointerDown || gestureActive) {
        onDismiss("cancel");
      } else if (!dismissed && timer === null && frame === null) {
        schedule(0);
      }
    },
    dispose() {
      cancel();
      doc.removeEventListener("pointerdown", onPointerDown as EventListener, true);
      element.removeEventListener("pointerdown", onSelectionStart);
      view.removeEventListener("pointerup", onPointerUp as EventListener);
      view.removeEventListener("mouseup", onMouseUp as EventListener);
      view.removeEventListener("pointercancel", dismiss);
      doc.removeEventListener("keydown", onKeyDown);
      doc.removeEventListener("focusin", onFocusIn);
      element.removeEventListener("contextmenu", onContextMenu, true);
      element.removeEventListener("scroll", onScroll, true);
      view.removeEventListener("blur", dismiss);
      view.removeEventListener("resize", dismiss);
    },
  };
}

/** Atalho de teclado para citar a seleção atual: ⌥⌘M no macOS, Ctrl+Shift+M nos demais. Pura. */
export function matchCommentShortcut(
  e: Pick<KeyboardEvent, "key" | "altKey" | "metaKey" | "ctrlKey" | "shiftKey">,
  mac: boolean,
): boolean {
  if (e.key.toLowerCase() !== "m") return false;
  return mac ? e.altKey && e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;
}
