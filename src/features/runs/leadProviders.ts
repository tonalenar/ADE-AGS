import type { RosterAgent } from "./types";

/** Workers need launchability; Leads additionally need the ADE MCP contract. */
export function providerDisabled(agent: RosterAgent, lead: boolean): boolean {
  return !agent.launchable || (lead && !agent.capabilities.orchestration);
}

export function leadUnsupported(agent: RosterAgent | undefined): boolean {
  return Boolean(agent && !agent.capabilities.orchestration);
}
