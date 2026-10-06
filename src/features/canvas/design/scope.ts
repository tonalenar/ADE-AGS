import type { Board } from "../board";
import { comparablePath } from "@/features/tabs/viewTabs";
import type { Artboard, Design, DesignDetail } from "./designApi";
import { BOARD_GAP, spreadOverlapping } from "./layout";

/** Margem entre o conteúdo do canvas e a área dos designs, e entre os grupos. */
export const AREA_GAP = 120;
/** Espaço da moldura em volta das pranchetas e altura do cabeçalho de cada prancheta. */
export const FRAME_PAD = 28;
export const FRAME_LABEL_H = 30;
export const BOARD_HEAD_H = 28;

/**
 * Os designs que pertencem a um canvas: o de uma missão mostra os da missão; o de uma pasta, os dessa
 * pasta que não são de nenhuma missão. Pura.
 */
export function designsForBoard(designs: Design[], scope: { cwd: string | null; missionId: string | null }): Design[] {
  if (scope.missionId) return designs.filter((d) => d.missionId === scope.missionId);
  if (!scope.cwd) return [];
  const cwd = comparablePath(scope.cwd);
  return designs.filter((d) => !d.missionId && !!d.workspace && comparablePath(d.workspace) === cwd);
}

/** O ponto livre do canvas: à direita de tudo o que já existe (terminais, notas, portais...). */
export function freeOrigin(board: Board): { x: number; y: number } {
  const boxes = [
    ...Object.values(board.nodes), ...Object.values(board.notes).map((n) => n.box), ...Object.values(board.portals).map((p) => p.box),
    ...Object.values(board.texts).map((t) => t.box), ...Object.values(board.images).map((i) => i.box), ...Object.values(board.folders).map((f) => f.box),
  ];
  if (boxes.length === 0) return { x: 0, y: 0 };
  return { x: Math.max(...boxes.map((b) => b.x + b.w)) + AREA_GAP, y: Math.min(...boxes.map((b) => b.y)) };
}

/** `x`/`y` no canvas; `lx`/`ly` a posição exibida relativa à página (a que se grava ao mover). */
export interface BoardPlacement { board: Artboard; x: number; y: number; lx: number; ly: number; saved: Artboard }
export interface DesignGroup {
  /** `designId:pageId`. */
  key: string;
  designId: string;
  pageId: string;
  title: string;
  /** Origem da página no canvas: x/y de cada prancheta é relativo a ela. */
  origin: { x: number; y: number };
  /** A moldura que envolve as pranchetas (coordenadas do canvas). */
  frame: { x: number; y: number; w: number; h: number };
  boards: BoardPlacement[];
}

/**
 * Arruma as páginas dos designs numa coluna a partir de `origin`, cada uma com sua moldura. As pranchetas
 * sem posição (todas em 0,0) saem lado a lado (`spreadOverlapping`). Pura: a posição gravada é
 * relativa à origem da página, então mover uma prancheta não desloca as outras.
 */
export function layoutGroups(details: DesignDetail[], origin: { x: number; y: number }): DesignGroup[] {
  const groups: DesignGroup[] = [];
  let y = origin.y;
  for (const detail of details) {
    for (const page of detail.pages) {
      const raw = detail.artboards.filter((a) => a.pageId === page.id);
      if (raw.length === 0) continue;
      const shown = spreadOverlapping(raw);
      const minX = Math.min(...shown.map((b) => b.x));
      const minY = Math.min(...shown.map((b) => b.y));
      const maxX = Math.max(...shown.map((b) => b.x + b.width));
      const maxY = Math.max(...shown.map((b) => b.y + b.height + BOARD_HEAD_H));
      const base = { x: origin.x + FRAME_PAD, y: y + FRAME_LABEL_H + FRAME_PAD };
      groups.push({
        key: `${detail.design.id}:${page.id}`,
        designId: detail.design.id,
        pageId: page.id,
        title: `${detail.design.title}/${page.name}`,
        origin: base,
        frame: { x: origin.x, y, w: maxX - minX + FRAME_PAD * 2, h: maxY - minY + FRAME_LABEL_H + FRAME_PAD * 2 },
        boards: shown.map((b) => ({ board: b, x: base.x + b.x - minX, y: base.y + b.y - minY, lx: b.x, ly: b.y, saved: raw.find((r) => r.id === b.id) ?? b })),
      });
      y += groups[groups.length - 1].frame.h + BOARD_GAP;
    }
  }
  return groups;
}

/**
 * O que gravar quando a prancheta `boardId` é solta em (x, y) do canvas: ela, na posição nova, e as
 * irmãs cuja posição exibida difere da gravada (ficavam empilhadas em 0,0 e só eram espalhadas na tela:
 * sem gravar, o espalhamento recomeçaria e desfaria o movimento). Pura.
 */
export function positionsToSave(group: Pick<DesignGroup, "boards">, boardId: string, x: number, y: number): Array<{ id: string; x: number; y: number }> {
  const out: Array<{ id: string; x: number; y: number }> = [];
  for (const p of group.boards) {
    if (p.board.id === boardId) out.push({ id: p.board.id, x: Math.round(p.lx + (x - p.x)), y: Math.round(p.ly + (y - p.y)) });
    else if (p.lx !== p.saved.x || p.ly !== p.saved.y) out.push({ id: p.board.id, x: p.lx, y: p.ly });
  }
  return out;
}

/** Os designs que ainda não eram conhecidos (o aviso "Novo design"). Pura. */
export function freshDesigns(known: ReadonlySet<string>, list: Design[]): Design[] {
  return list.filter((d) => !known.has(d.id));
}
