export type DecisionProviderId = "none" | "laya_local" | "laya_studio" | "jev";

export interface DecisionSettings {
  enabled: boolean;
  provider: DecisionProviderId;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  memoryApproval: boolean;
  dreamTriage: boolean;
  fleetGate: boolean;
  missionGate: boolean;
  keySaved: boolean;
}

export const PROVIDER_URL: Record<DecisionProviderId, string> = {
  none: "http://localhost:8000",
  laya_local: "http://localhost:8000",
  laya_studio: "https://api.laya.studio",
  jev: "https://api.typesafe.ai",
};

export function defaultDecisionSettings(): DecisionSettings {
  return {
    enabled: false,
    provider: "none",
    baseUrl: PROVIDER_URL.laya_local,
    model: "multilingual",
    timeoutMs: 800,
    memoryApproval: false,
    dreamTriage: false,
    fleetGate: false,
    missionGate: false,
    keySaved: false,
  };
}

export function clampTimeout(value: number): number {
  if (!Number.isFinite(value)) return 800;
  return Math.min(30_000, Math.max(50, Math.round(value)));
}

function knownUrl(value: string): boolean {
  const trimmed = value.trim().replace(/\/$/, "");
  return Object.values(PROVIDER_URL).some((url) => url === trimmed);
}

/** Troca a URL padrão junto com o provedor. Uma URL escrita à mão fica. */
export function urlAfterProviderChange(current: string, next: DecisionProviderId): string {
  if (!current.trim() || knownUrl(current)) return PROVIDER_URL[next];
  return current;
}
