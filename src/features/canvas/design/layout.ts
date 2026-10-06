/** Espaço entre pranchetas organizadas automaticamente (px do canvas). */
export const BOARD_GAP = 48;

interface Box { x: number; y: number; width: number; height: number }

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Pranchetas criadas pelo CLI sem posição ficam todas em (0, 0), uma em cima da outra, e os títulos se
 * misturam. Se alguma se sobrepõe a outra, as dispõe lado a lado, na ordem, com um espaço entre elas;
 * sem sobreposição devolve as posições como estão (o usuário pode ter arrumado à mão). Pura: só muda a
 * exibição, não grava nada.
 */
export function spreadOverlapping<T extends Box>(boards: T[]): T[] {
  const stacked = boards.some((a, i) => boards.some((b, j) => j > i && overlaps(a, b)));
  if (!stacked) return boards;
  let x = 0;
  return boards.map((board) => {
    const placed = { ...board, x, y: 0 };
    x += board.width + BOARD_GAP;
    return placed;
  });
}
