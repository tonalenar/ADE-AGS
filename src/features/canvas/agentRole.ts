import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * O que um terminal é no time: uma função (QA, Backend…) ou nenhuma. Sem função (`roleId: null`)
 * o orquestrador decide, quando o terminal é ligado a ele por uma corda (`ags peer role`).
 * `subagent` marca apoio que o orquestrador comanda; quantos a pessoa quiser.
 */
export interface AgentRoleChoice {
  roleId: string | null;
  subagent: boolean;
}

export const NO_ROLE: AgentRoleChoice = { roleId: null, subagent: false };

/** Uma função do catálogo ou criada pelo usuário (`ags role create`). */
export interface CanvasRole {
  id: string;
  label: string;
  instructions: string;
}

/** Funções internas que não são trabalho de um terminal do canvas (o Dreamer cuida da memória). */
const HIDDEN = new Set(["dreamer"]);

let cache: Promise<CanvasRole[]> | null = null;

/** O catálogo de funções, lido uma vez. Falhar não pode travar o diálogo: volta lista vazia. */
export function loadCanvasRoles(): Promise<CanvasRole[]> {
  cache ??= invoke<CanvasRole[]>("canvas_roles_all")
    .then((all) => all.filter((role) => !HIDDEN.has(role.id)))
    .catch(() => { cache = null; return []; });
  return cache;
}

export function useCanvasRoles(): CanvasRole[] {
  const [roles, setRoles] = useState<CanvasRole[]>([]);
  useEffect(() => {
    let alive = true;
    void loadCanvasRoles().then((all) => { if (alive) setRoles(all); });
    return () => { alive = false; };
  }, []);
  return roles;
}

/** O rótulo guardado no canvas (`board.roles`) para a função escolhida; `null` = sem função. */
export function roleLabelOf(roles: CanvasRole[], roleId: string | null): string | null {
  if (!roleId) return null;
  return roles.find((role) => role.id === roleId)?.label ?? null;
}

/** A escolha que corresponde ao rótulo que está no canvas (ou sem função, se não achar). */
export function choiceFromLabel(roles: CanvasRole[], label: string | undefined, subagent: boolean): AgentRoleChoice {
  const role = label ? roles.find((r) => r.label === label) : undefined;
  return { roleId: role?.id ?? null, subagent };
}

/**
 * O que o agente lê ao receber a função, ou `null` se não há nada a dizer (sem função e não é subagente).
 * Segue o texto do `ags peer recruit --role` ("Seu papel neste time: …").
 */
export function roleBriefing(roles: CanvasRole[], choice: AgentRoleChoice): string | null {
  const role = choice.roleId ? roles.find((r) => r.id === choice.roleId) : undefined;
  const parts: string[] = [];
  if (role) parts.push(`Seu papel neste time: ${role.label} — ${role.instructions}`);
  if (choice.subagent) {
    parts.push(role
      ? "Você é um subagente: execute as tarefas que o orquestrador enviar e responda com `ags peer tell`."
      : "Você é um subagente deste time. O orquestrador vai definir o seu papel e enviar as tarefas: aguarde.");
  }
  return parts.length > 0 ? `[ADE AGS] ${parts.join("\n")}` : null;
}
