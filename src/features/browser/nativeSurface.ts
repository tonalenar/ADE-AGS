/**
 * O que um conteúdo nativo por cima do webview (o navegador do Portal, a tela do simulador iOS) precisa saber do
 * DOM: o retângulo do elemento que reserva o espaço, quem o recorta e o que do app está por cima dele.
 */
import { intersect, type Box } from "./realBrowser";

/** O que do app pode ficar por cima da página: menus, diálogos, dicas, o painel lateral. */
export const OVERLAYS = 'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"], [popover], [data-radix-popper-content-wrapper], [data-session-panel], [data-over-webview]:not([data-over-webview="hit"]), [data-native-overlay]';
/** Controles invisíveis que só precisam receber clique/hover sem abrir buraco visual na página nativa. */
export const HIT_OVERLAYS = '[data-over-webview="hit"]';
/** A grade de pontos que procura o que está por cima (outro nó do canvas, um popover sem papel ARIA). */
export const GRID = { cols: 12, rows: 8 };
/** De quanto em quanto tempo procurar o que está por cima (o lugar do Portal é medido a cada quadro). */
export const COVER_MS = 120;

export function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function isOpaqueAndShown(el: Element): boolean {
  const s = getComputedStyle(el);
  if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") return false;
  const opacity = s.opacity === "" ? 1 : Number.parseFloat(s.opacity);
  return !Number.isFinite(opacity) || opacity > 0;
}

function isVisibleOverlay(el: Element): boolean {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (!isOpaqueAndShown(cur)) return false;
  }
  return true;
}

function ancestorChain(el: Element): Element[] {
  const chain: Element[] = [];
  for (let cur: Element | null = el; cur; cur = cur.parentElement) chain.push(cur);
  return chain.reverse();
}

/** Primeiro `z-index` numérico a partir de `branch` até `leaf`, representando o nível no contexto do LCA. */
function stackingLevel(chain: Element[], startIndex: number): number | null {
  for (let i = startIndex; i < chain.length; i++) {
    const z = getComputedStyle(chain[i]!).zIndex;
    if (z && z !== "auto") {
      const parsed = Number(z);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/** Verdadeiro quando `overlay` pinta acima de `surface` na ordem de empilhamento (z-index / ordem do DOM). */
function isAboveInPaintOrder(overlay: Element, surface: Element, overlap: Box): boolean {
  const overlayChain = ancestorChain(overlay);
  const surfaceChain = ancestorChain(surface);
  let common = 0;
  const limit = Math.min(overlayChain.length, surfaceChain.length);
  while (common < limit && overlayChain[common] === surfaceChain[common]) common += 1;

  const overlayZ = stackingLevel(overlayChain, common);
  const surfaceZ = stackingLevel(surfaceChain, common);
  if (overlayZ !== null || surfaceZ !== null) {
    const oz = overlayZ ?? 0;
    const sz = surfaceZ ?? 0;
    if (oz !== sz) return oz > sz;
  }

  // Se o overlay recebe ponteiro e o ponto central da interseção acerta a própria superfície nativa, está atrás dela.
  if (getComputedStyle(overlay).pointerEvents !== "none") {
    const hit = document.elementFromPoint(overlap.x + overlap.width / 2, overlap.y + overlap.height / 2);
    if (hit && (hit === surface || surface.contains(hit))) return false;
  }

  return Boolean(surface.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_FOLLOWING);
}

/** Os ancestrais que recortam o que passa da borda deles (o canvas, a área de conteúdo). */
export function clippingAncestors(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let p = el.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (s.overflowX !== "visible" || s.overflowY !== "visible") out.push(p);
  }
  return out;
}

/** Áreas somente de recorte de clique (`data-over-webview="hit"`), sem abrir buraco visual no nativo. */
export function hitCoversOf(el: HTMLElement): Box[] {
  const out: Box[] = [];
  for (const overlay of document.querySelectorAll(HIT_OVERLAYS)) {
    if (overlay.contains(el) || el.contains(overlay) || !isVisibleOverlay(overlay)) continue;
    const box = boxOf(overlay);
    if (box.width > 0 && box.height > 0) out.push(box);
  }
  return out;
}

/** O que do app está por cima do elemento nativo `el`: o maior bloco acima dele que não o contém. */
export function coversOf(el: HTMLElement, rect: Box, ignore?: string): Box[] {
  const found = new Set<Element>();
  for (const overlay of document.querySelectorAll(OVERLAYS)) {
    if (overlay.contains(el) || el.contains(overlay) || !isVisibleOverlay(overlay)) continue;
    const overlap = intersect(boxOf(overlay), rect);
    if (!overlap || !isAboveInPaintOrder(overlay, el, overlap)) continue;
    found.add(overlay);
  }
  for (let i = 0; i < GRID.cols; i++) {
    for (let j = 0; j < GRID.rows; j++) {
      const hit = document.elementFromPoint(rect.x + ((i + 0.5) * rect.width) / GRID.cols, rect.y + ((j + 0.5) * rect.height) / GRID.rows);
      if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
      // Recorte somente de clique não abre buraco visual na página nem pela grade de detecção.
      if (hit.closest(HIT_OVERLAYS)) continue;
      // Quem pede pode ignorar o que não deve abrir buraco (o simulador fica por cima dos outros nós).
      if (ignore && hit.closest(ignore)) continue;
      // Menu ou diálogo conhecido dentro da casca do chat não deve escalar até `[data-chat-shell]`.
      const known = hit.closest(OVERLAYS);
      if (known && !known.contains(el) && !el.contains(known)) {
        if (isVisibleOverlay(known)) found.add(known);
        continue;
      }
      const chain: Element[] = [];
      let top: Element | null = hit;
      while (top && !top.contains(el)) {
        chain.push(top);
        if (!top.parentElement || top.parentElement.contains(el)) break;
        top = top.parentElement;
      }
      const root = chain[chain.length - 1];
      if (!root) continue;
      // No modo chat, `<EditorArea>` fica acima da casca (`z-20`); só filhos com `z-index` explícito ficam por cima dela.
      if (chain.some((node) => node.hasAttribute("data-chat-shell"))) {
        let stacked: Element | null = null;
        for (let k = chain.length - 1; k >= 0; k--) {
          const candidate = chain[k]!;
          if (candidate.hasAttribute("data-chat-shell") || candidate.hasAttribute("data-column-tabbar") || candidate.tagName === "MAIN" || candidate.tagName === "ASIDE") continue;
          const z = getComputedStyle(candidate).zIndex;
          if (z && z !== "auto" && Number(z) !== 0) {
            stacked = candidate;
            break;
          }
        }
        if (stacked && isVisibleOverlay(stacked)) found.add(stacked);
        continue;
      }
      if (isVisibleOverlay(root)) found.add(root);
    }
  }
  return [...found].map(boxOf).filter((b) => b.width > 0 && b.height > 0);
}
