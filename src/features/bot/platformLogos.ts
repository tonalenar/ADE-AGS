/**
 * Logos pixel-art 12x12 das plataformas de agente, desenhados a mão em texto: sem imagens
 * externas. `.` = transparente; `a` = cor principal; `b` = cor de destaque.
 */
export type LogoKind = "claude" | "codex" | "antigravity" | "gemini" | "opencode" | "generic";

export const LOGO_SIZE = 12;

export interface PixelLogo { rows: readonly string[]; a: string; b: string }

export const PIXEL_LOGOS: Record<LogoKind, PixelLogo> = {
  claude: {
    a: "#d97757", b: "#f4b79b",
    rows: [
      ".....aa.....",
      ".a...aa...a.",
      "..a..aa..a..",
      "...a.aa.a...",
      "....aaaa....",
      "aaaaabbaaaaa",
      "aaaaabbaaaaa",
      "....aaaa....",
      "...a.aa.a...",
      "..a..aa..a..",
      ".a...aa...a.",
      ".....aa.....",
    ],
  },
  codex: {
    a: "#e9eaf2", b: "#2b2d42",
    rows: [
      "...aaaaaa...",
      ".aaaaaaaaaa.",
      "aaaaaaaaaaaa",
      "aabaaaaaaaaa",
      "aaabaaaaaaaa",
      "aaaabaaaaaaa",
      "aaabaaabbbaa",
      "aabaaaaaaaaa",
      "aaaaaaaaaaaa",
      "aaaaaaaaaaaa",
      ".aaaaaaaaaa.",
      "...aaaaaa...",
    ],
  },
  antigravity: {
    a: "#7b61ff", b: "#4fc3f7",
    rows: [
      ".....aa.....",
      ".....aa.....",
      "....aaaa....",
      "....aaaa....",
      "...aa..aa...",
      "...aa..aa...",
      "..aa....aa..",
      "..aa....aa..",
      ".aa..bb..aa.",
      ".aa..bb..aa.",
      "aa...bb...aa",
      "aa........aa",
    ],
  },
  gemini: {
    a: "#4285f4", b: "#9b72cb",
    rows: [
      ".....aa.....",
      ".....aa.....",
      ".....aa.....",
      "....aaaa....",
      "..aaaabbaa..",
      "aaaaabbbbaaa",
      "aaabbbbaaaaa",
      "..aabbaaaa..",
      "....aaaa....",
      ".....aa.....",
      ".....aa.....",
      ".....aa.....",
    ],
  },
  opencode: {
    a: "#cfd2dc", b: "#6b7084",
    rows: [
      "aaaaaaaaaaaa",
      "a..........a",
      "a.bbbbbbbb.a",
      "a.b......b.a",
      "a.b......b.a",
      "a.b......b.a",
      "a.b......b.a",
      "a.b......b.a",
      "a.b......b.a",
      "a.bbbbbbbb.a",
      "a..........a",
      "aaaaaaaaaaaa",
    ],
  },
  generic: {
    a: "#a89bbf", b: "#2b2438",
    rows: [
      ".....aa.....",
      ".....aa.....",
      "..aaaaaaaa..",
      ".aaaaaaaaaa.",
      ".aabbaabbaa.",
      ".aabbaabbaa.",
      ".aaaaaaaaaa.",
      ".aabbbbbbaa.",
      ".aaaaaaaaaa.",
      "..aaaaaaaa..",
      "...a....a...",
      "...a....a...",
    ],
  },
};

/** Cada pixel a pintar: `[coluna, linha, cor]`. Pura (o canvas só desenha o que sai daqui). */
export function logoPixels(kind: LogoKind): Array<[number, number, string]> {
  const logo = PIXEL_LOGOS[kind] ?? PIXEL_LOGOS.generic;
  const out: Array<[number, number, string]> = [];
  logo.rows.forEach((row, y) => {
    [...row].forEach((cell, x) => {
      if (cell === "a") out.push([x, y, logo.a]);
      else if (cell === "b") out.push([x, y, logo.b]);
    });
  });
  return out;
}
