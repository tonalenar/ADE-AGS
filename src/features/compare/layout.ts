/**
 * Onde ficam os terminais de uma comparação de modelos no canvas: lado a lado, sob um rótulo
 * "Comparação: <título>". Até 3 numa linha; de 4 a 6, duas linhas. Puro: sem store nem React.
 */
import type { Board } from "@/features/canvas/board";
import type { Box, Viewport } from "@/features/canvas/geometry";

/** Um terminal da comparação: a aba e o rótulo que o nó mostra (agente · modelo · esforço). */
export interface ComparisonNode {
  tabId: string;
  label: string;
}

/** Menor que o terminal padrão (760×460): seis lado a lado ainda cabem numa tela com zoom. */
export const CMP_NODE = { w: 640, h: 520 };
export const CMP_GAP = 40;
/** Altura reservada ao rótulo do grupo, acima dos terminais. */
export const CMP_TITLE_H = 56;
export const CMP_TITLE_SIZE = 22;

/** Quantas colunas: todos numa linha até 3; depois, duas linhas. */
export function comparisonColumns(count: number): number {
  if (count <= 0) return 0;
  return count <= 3 ? count : Math.ceil(count / 2);
}

/** O rótulo e as caixas de `count` terminais a partir de `origin` (canto de cima à esquerda). */
export function comparisonLayout(count: number, origin: { x: number; y: number }): { title: Box; nodes: Box[] } {
  const cols = comparisonColumns(count);
  const width = cols * CMP_NODE.w + Math.max(0, cols - 1) * CMP_GAP;
  const nodes = Array.from({ length: count }, (_, i) => ({
    x: origin.x + (i % cols) * (CMP_NODE.w + CMP_GAP),
    y: origin.y + CMP_TITLE_H + Math.floor(i / cols) * (CMP_NODE.h + CMP_GAP),
    w: CMP_NODE.w,
    h: CMP_NODE.h,
  }));
  return { title: { x: origin.x, y: origin.y, w: Math.max(width, 240), h: 44 }, nodes };
}

/** Abaixo de tudo o que já está no canvas (um canvas de comparação novo começa vazio). */
export function comparisonOrigin(board: Board, ignore: ReadonlySet<string> = new Set()): { x: number; y: number } {
  const boxes: Box[] = [
    ...Object.entries(board.nodes).filter(([id]) => !ignore.has(id)).map(([, b]) => b),
    ...Object.entries(board.texts).filter(([id]) => !ignore.has(id)).map(([, t]) => t.box),
    ...Object.values(board.notes).map((n) => n.box),
    ...Object.values(board.portals).map((p) => p.box),
  ];
  if (boxes.length === 0) return { x: 40, y: 40 };
  return {
    x: Math.min(...boxes.map((b) => b.x)),
    y: Math.max(...boxes.map((b) => b.y + b.h)) + CMP_GAP * 2,
  };
}

/** Uma vista que mostra o grupo inteiro numa área de `available` px de largura (zoom de 0,45 a 1). */
export function comparisonViewport(count: number, origin: { x: number; y: number }, available = 1500): Viewport {
  const cols = comparisonColumns(count);
  const width = cols * CMP_NODE.w + Math.max(0, cols - 1) * CMP_GAP;
  const zoom = Math.round(Math.min(1, Math.max(0.45, available / Math.max(width, 1))) * 100) / 100;
  return { x: Math.round(40 - origin.x * zoom), y: Math.round(96 - origin.y * zoom), zoom };
}

/**
 * Monta o grupo: cada terminal na sua caixa e com o seu rótulo, mais o texto do título. Os nós
 * de outras abas não se movem. Puro.
 */
export function buildComparisonBoard(board: Board, titleId: string, title: string, entries: ComparisonNode[]): Board {
  const ignore = new Set([titleId, ...entries.map((e) => e.tabId)]);
  const origin = comparisonOrigin(board, ignore);
  const layout = comparisonLayout(entries.length, origin);
  const nodes = { ...board.nodes };
  const roles = { ...board.roles };
  entries.forEach((entry, i) => {
    nodes[entry.tabId] = layout.nodes[i];
    roles[entry.tabId] = entry.label;
  });
  return {
    ...board,
    nodes,
    roles,
    texts: { ...board.texts, [titleId]: { text: title, size: CMP_TITLE_SIZE, box: layout.title } },
    viewport: comparisonViewport(entries.length, origin),
  };
}
