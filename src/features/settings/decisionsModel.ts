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

/** Checkpoints da Laya. A Studio aceita `jev-latest` e ignora; o seletor oferece estes. */
const LAYA_MODELS = ["multilingual", "english", "typed-decisions"] as const;

/** Aliases e o id versionado que o Jev (`api.typesafe.ai`) aceita no campo `model`. */
const JEV_MODELS = ["jev-latest", "jev-preview", "jev-1.13.0"] as const;

/** O que o dropdown oferece. `none` e a Laya usam os checkpoints; o Jev, os nomes dele. */
export function modelsFor(provider: DecisionProviderId): readonly string[] {
  return provider === "jev" ? JEV_MODELS : LAYA_MODELS;
}

/** Padrão do provedor. No Jev é `jev-latest` (hoje `jev-1.13.0`). */
export function defaultModel(provider: DecisionProviderId): string {
  return provider === "jev" ? "jev-latest" : "multilingual";
}

/** Ao trocar de provedor, um modelo que o destino não aceita vira o padrão dele. */
export function modelAfterProviderChange(current: string, next: DecisionProviderId): string {
  return modelsFor(next).includes(current) ? current : defaultModel(next);
}

export function defaultDecisionSettings(): DecisionSettings {
  return {
    enabled: false,
    provider: "none",
    baseUrl: PROVIDER_URL.laya_local,
    model: defaultModel("none"),
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

/** O que vale ao sair do campo de timeout: vazio ou texto sem número volta ao padrão (800 ms), o resto é limitado a 50 a 30000. Pura. */
export function parseTimeout(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 800;
  const value = Number(trimmed);
  return Number.isFinite(value) ? clampTimeout(value) : 800;
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
