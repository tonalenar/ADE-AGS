import { invoke } from "@tauri-apps/api/core";

import type { AskKind, PermissionRule } from "./permissionModel";

/**
 * As regras «Sempre permitir» moram no banco (`chat_permission_rule`), onde o backend decide os pedidos das
 * conversas por protocolo sem a janela. Só a pessoa, por aqui, cria, muda ou apaga regras.
 */
export interface RuleRow {
  id: string;
  kind: AskKind;
  pattern: string;
  agentId: string | null;
  /** Preparados para a etapa seguinte (regra por papel ou por time); ainda não valem. */
  role: string | null;
  teamId: string | null;
  createdAt: number;
}

export const ruleOf = (row: RuleRow): PermissionRule => ({ id: row.id, kind: row.kind, pattern: row.pattern, agentId: row.agentId, createdAt: row.createdAt });

export const chatPermissionRules = () => invoke<RuleRow[]>("chat_permission_rules");
export const chatPermissionRuleAdd = (input: { kind: AskKind; pattern: string; agentId: string | null }) => invoke<RuleRow>("chat_permission_rule_add", { input });
export const chatPermissionRuleUpdate = (id: string, patch: { pattern?: string; agentId?: string; anyAgent?: boolean }) => invoke<boolean>("chat_permission_rule_update", { id, patch });
export const chatPermissionRuleRemove = (id: string) => invoke<boolean>("chat_permission_rule_remove", { id });
export const chatTeamAutoDecide = (teamId: string, enabled: boolean) => invoke<boolean>("chat_team_auto_decide", { teamId, enabled });
export const chatTeamAllowTools = (teamId: string, enabled: boolean) => invoke<boolean>("chat_team_allow_tools", { teamId, enabled });
export const chatTeamWatch = (teamId: string, enabled: boolean) => invoke<boolean>("chat_team_watch", { teamId, enabled });
export const chatTeamWatchStall = (teamId: string, enabled: boolean) => invoke<boolean>("chat_team_watch_stall", { teamId, enabled });
