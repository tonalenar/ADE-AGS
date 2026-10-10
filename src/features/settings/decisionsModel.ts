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

/** Algo mudou em relação ao que está salvo (a chave do cofre fica de fora). Pura. */
export function isDirty(current: DecisionSettings, saved: DecisionSettings): boolean {
  const strip = ({ keySaved: _ignored, ...rest }: DecisionSettings) => JSON.stringify(rest);
  return strip(current) !== strip(saved);
}

export function clampTimeout(value: number): number {
  if (!Number.isFinite(value)) return 800;
  return Math.min(30_000, Math.max(50, Math.round(value)));
}

/** O host de um endereço, ou null se não der para ler. */
export function urlHost(value: string): string | null {
  try {
    return new URL(value.trim()).hostname;
  } catch {
    return null;
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** O texto das propostas fica nesta máquina? Um endereço ilegível conta como de fora. */
export function isLocalUrl(value: string): boolean {
  const host = urlHost(value);
  return host !== null && LOCAL_HOSTS.has(host);
}

/** O aviso de privacidade vale com um provedor escolhido e o endereço fora desta máquina. */
export function sendsOffMachine(settings: Pick<DecisionSettings, "provider" | "baseUrl">): boolean {
  return settings.provider !== "none" && !isLocalUrl(settings.baseUrl);
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
