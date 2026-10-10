import { invoke } from "@tauri-apps/api/core";

import type { DecisionSettings } from "./decisionsModel";

export interface ConnectionTest {
  ok: boolean;
  latencyMs: number;
  error: string | null;
}

export interface PointReport {
  point: string;
  total: number;
  agreementRate: number;
  p50Ms: number | null;
  p95Ms: number | null;
  errorRate: number;
  timeoutRate: number;
}

export interface Disagreement {
  point: string;
  stateHash: string;
  heuristic: string;
  providerDecision: string;
}

export interface ShadowReport {
  generatedAt: number;
  points: PointReport[];
  disagreements: Disagreement[];
}

export const getDecisionSettings = () => invoke<DecisionSettings>("decision_settings_get");

export const setDecisionSettings = (settings: Omit<DecisionSettings, "keySaved">) =>
  invoke<DecisionSettings>("decision_settings_set", { input: settings });

export const setDecisionKey = (key: string) => invoke<void>("decision_key_set", { key });

export const clearDecisionKey = () => invoke<void>("decision_key_clear");

export const testDecisionConnection = () => invoke<ConnectionTest>("decision_test_connection");

export const decisionShadowReport = () => invoke<ShadowReport>("decision_shadow_report");

export const decisionShadowCsv = () => invoke<string>("decision_shadow_export_csv");
