/** Um matiz por ramo, no ordem em que aparecem. Tokens do tema, sem hex. */
export const GRAPH_PALETTE = [
  "var(--color-blue-500)",
  "var(--color-violet-500)",
  "var(--color-orange-500)",
  "var(--color-green-500)",
  "var(--color-pink-500)",
  "var(--color-yellow-500)",
  "var(--color-cyan-500)",
  "var(--color-red-500)",
] as const;

export const colorOfLane = (i: number): string => GRAPH_PALETTE[i % GRAPH_PALETTE.length];
