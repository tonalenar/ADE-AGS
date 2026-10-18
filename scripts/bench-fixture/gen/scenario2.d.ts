/** Tipos de `scenario2.js` (JS puro: a página o importa direto no navegador). */
import type { RawCriterion } from "./scenario.js";

export type SolveStep = { click?: string; near?: string; fill?: [string, string]; select?: [string, string]; follow?: string };

export interface Scenario2 {
  family: string;
  seed: number;
  lang: "pt" | "en" | "es";
  store: string;
  goal: string;
  fills: string[];
  success: RawCriterion;
  forbid?: RawCriterion;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- o desenho de cada família tem campos próprios
  view: Record<string, any>;
  solve: SolveStep[];
}

export const FAMILIES2: string[];
export const SEEDS2: number;
export function scenario2(family: string, seed: number): Scenario2;
