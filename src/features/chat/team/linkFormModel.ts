import { hasEffort } from "../AgentModelPicker";

/** O «Ligar ao time» oferece esforço também no OpenCode (a `variant` da sessão ACP); o seletor da TUI não. */
export const linkEffortSupported = (agentId: string | null): boolean => agentId === "opencode" || (agentId !== null && hasEffort(agentId));

/** O papel de quem é só subagente: apoio que executa o que o orquestrador manda, sem especialidade. */
export const SUBAGENT_ROLE = "generalist";
/** O esforço de um subagente novo, a não ser que a pessoa (ou o pedido no chat) escolha outro. */
export const SUBAGENT_DEFAULT_EFFORT = "low";

/** O papel que vai ao time: com o subagente ligado, o seletor de Papel fica inativo mostrando "Subagente". Pura. */
export function effectiveRole(role: string, subagent: boolean): string {
  return subagent ? SUBAGENT_ROLE : role;
}

/**
 * O esforço que vai ao agente novo. Escolha da pessoa vale sempre; sem escolha, um subagente nasce no esforço baixo
 * (nos agentes que têm esforço) e os demais ficam no padrão. Pura.
 */
export function effectiveEffort({ effort, touched, subagent, agentId }: { effort: string | null; touched: boolean; subagent: boolean; agentId: string | null }): string | null {
  if (touched) return effort;
  if (subagent && linkEffortSupported(agentId)) return SUBAGENT_DEFAULT_EFFORT;
  return effort;
}
