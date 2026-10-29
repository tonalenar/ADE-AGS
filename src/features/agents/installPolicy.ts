/** O que a linha de um agente ausente mostra. A política de qual comando roda fica no Rust. */

export interface AgentInstallOffer {
  agentId: string;
  canInstall: boolean;
  needsRuntime: boolean;
  manual: string | null;
}

export type InstallRow =
  | { kind: "button"; enabled: boolean }
  | { kind: "manual"; command: string }
  | { kind: "runtime" }
  | { kind: "app" }
  | { kind: "none" };

export function installRowState(
  available: boolean,
  offer: AgentInstallOffer | undefined,
  busy: boolean,
): InstallRow {
  if (available || !offer) return { kind: "none" };
  if (offer.canInstall) return { kind: "button", enabled: !busy };
  if (offer.manual) return { kind: "manual", command: offer.manual };
  if (offer.needsRuntime) return { kind: "runtime" };
  return { kind: "app" };
}
