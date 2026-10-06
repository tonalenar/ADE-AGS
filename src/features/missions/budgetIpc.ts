import { invoke } from "@tauri-apps/api/core";

import type { BudgetGatedAction, BudgetStatus, PlanLimits } from "./budgetTypes";

export const missionBudget = (missionId: string) => invoke<BudgetStatus>("mission_budget", { missionId });
export const raiseMissionBudget = (missionId: string, budgetUsd: number) =>
  invoke<BudgetStatus>("mission_raise_budget", { missionId, budgetUsd });
export const continueOverBudget = (missionId: string, action: BudgetGatedAction) =>
  invoke<BudgetStatus>("mission_budget_continue", { missionId, action });
export const planLimits = () => invoke<PlanLimits[]>("plan_limits");
