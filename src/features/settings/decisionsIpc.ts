import { invoke } from "@tauri-apps/api/core";

import type { DecisionSettings } from "./decisionsModel";

export interface ConnectionTest {
  ok: boolean;
  latencyMs: number;
  error: string | null;
}

export interface PairCount {
  heuristic: string;
  provider: string;
  count: number;
}

/** A concordância de uma pergunta. `blindRate` é a parcela em que o provedor escolheu um rótulo
 * que a heurística daquele ponto nunca devolve (`blindLabels`). */
export interface QuestionReport {
  question: string;
  compared: number;
  agreementRate: number;
  blindRate: number;
  blindLabels: string[];
  pairs: PairCount[];
}

export interface PointReport {
  point: string;
  /** Qual provedor respondeu: com dois ligados há um cartão por (ponto, provedor). */
  provider: string;
  total: number;
  compared: number;
  lowSample: boolean;
  agreementRate: number;
  p50Ms: number | null;
  p95Ms: number | null;
  errorRate: number;
  timeoutRate: number;
  questions: QuestionReport[];
}

export interface Disagreement {
  point: string;
  stateHash: string;
  heuristic: string;
  providerDecision: string;
}

/** Dois provedores diante das MESMAS propostas. Em cada par, `heuristic` é o que o provedor A disse e
 * `provider` o que o B disse. */
export interface Comparison {
  point: string;
  providerA: string;
  providerB: string;
  compared: number;
  agreementRate: number;
  questions: QuestionReport[];
}

/** Quem chegou mais perto da decisão da pessoa nas propostas de memória (`heuristic` é a heurística do app). */
export interface Judged {
  provider: string;
  decided: number;
  correct: number;
  wrong: number;
  abstained: number;
}

export interface ShadowReport {
  generatedAt: number;
  minSample: number;
  points: PointReport[];
  comparisons: Comparison[];
  judged: Judged[];
  disagreements: Disagreement[];
}

export const getDecisionSettings = () => invoke<DecisionSettings>("decision_settings_get");

export type KeySlot = "primary" | "secondary";

export const setDecisionSettings = (settings: Omit<DecisionSettings, "keySaved" | "secondaryKeySaved">) =>
  invoke<DecisionSettings>("decision_settings_set", { input: settings });

export const setDecisionKey = (key: string, slot: KeySlot = "primary") => invoke<void>("decision_key_set", { key, slot });

export const clearDecisionKey = (slot: KeySlot = "primary") => invoke<void>("decision_key_clear", { slot });

export const testDecisionConnection = (slot: KeySlot = "primary") => invoke<ConnectionTest>("decision_test_connection", { slot });

export const decisionShadowReport = () => invoke<ShadowReport>("decision_shadow_report");

export const decisionShadowCsv = () => invoke<string>("decision_shadow_export_csv");
