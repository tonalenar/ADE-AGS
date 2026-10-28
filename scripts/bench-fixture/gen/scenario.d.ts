/** Tipos de `scenario.js` (o módulo é JS puro porque a página o importa direto no navegador). */
export type RawCriterion = { kind: "text" | "url"; value: string } | { kind: "all"; of: RawCriterion[] };

export interface Scenario {
  family: string;
  seed: number;
  lang: "pt" | "en" | "es";
  store: string;
  goal: string;
  fills: string[];
  success: RawCriterion;
  forbid?: RawCriterion;
  view: Record<string, unknown>;
}

export const FAMILIES: string[];
export const SEEDS: number;
export function rng(seed: number): () => number;
export function scenario(family: string, seed: number): Scenario;
