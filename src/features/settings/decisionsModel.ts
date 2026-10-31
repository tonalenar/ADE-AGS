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
  /** O Vigia pergunta ao Jev se uma mensagem ao Orquestrador é relatório final (envia o começo do texto). */
  deliveryGate: boolean;
  memoryRelevance: boolean;
  turnRouting: boolean;
  /** O Jev pilota o navegador do canvas (`ags portal act`): o texto da página sai da máquina. */
  browserPilot: boolean;
  /** Reserva visual do piloto: uma FOTO da página sai da máquina quando o texto não basta. */
  browserVision: boolean;
  keySaved: boolean;
  /** O segundo provedor da comparação (`none` = só o principal). */
  secondaryProvider: DecisionProviderId;
  secondaryBaseUrl: string;
  secondaryModel: string;
  secondaryKeySaved: boolean;
  /** Uma versão fixada do Jev sobe sozinha para a mais nova (o app confere ao abrir e uma vez por dia). */
  modelAutoUpdate: boolean;
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
const JEV_MODELS = ["jev-latest", "jev-preview", "jev-1.14.0"] as const;

/** `jev-1.14.0` e afins: uma versão do Jev, que pode ser mais nova que as que o app conhece. Pura. */
export function isJevVersion(model: string): boolean {
  return /^jev-\d+\.\d+\.\d+$/.test(model.trim());
}

/** O que o seletor de modelo oferece: os nomes do provedor, as versões que o Jev listou e o modelo atual (nunca some
 *  da lista um modelo que está em uso). Pura. */
export function modelOptions(provider: DecisionProviderId, listed: readonly string[], current: string): string[] {
  const base = provider === "jev" && listed.length > 0 ? [...listed] : [...modelsFor(provider)];
  const shown = modelAfterProviderChange(current, provider);
  return base.includes(shown) ? base : [...base, shown];
}

/** O que o dropdown oferece. `none` e a Laya usam os checkpoints; o Jev, os nomes dele. */
export function modelsFor(provider: DecisionProviderId): readonly string[] {
  return provider === "jev" ? JEV_MODELS : LAYA_MODELS;
}

/** Padrão do provedor. No Jev é `jev-latest` (o próprio Jev o aponta para a versão mais nova). */
export function defaultModel(provider: DecisionProviderId): string {
  return provider === "jev" ? "jev-latest" : "multilingual";
}

/** Ao trocar de provedor, um modelo que o destino não aceita vira o padrão dele. */
export function modelAfterProviderChange(current: string, next: DecisionProviderId): string {
  return modelsFor(next).includes(current) || (next === "jev" && isJevVersion(current)) ? current : defaultModel(next);
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
    deliveryGate: false,
    memoryRelevance: false,
    turnRouting: false,
    browserPilot: false,
    browserVision: false,
    keySaved: false,
    secondaryProvider: "none",
    secondaryBaseUrl: PROVIDER_URL.jev,
    secondaryModel: defaultModel("jev"),
    secondaryKeySaved: false,
    modelAutoUpdate: true,
  };
}

/** Algo mudou em relação ao que está salvo (a chave do cofre fica de fora). Pura. */
export function isDirty(current: DecisionSettings, saved: DecisionSettings): boolean {
  const strip = ({ keySaved: _a, secondaryKeySaved: _b, ...rest }: DecisionSettings) => JSON.stringify(rest);
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

/** Os endereços (hosts) que recebem o texto das propostas e ficam fora desta máquina: o principal e o
 * segundo, se estiverem ligados. Pura. */
export function remoteHosts(settings: Pick<DecisionSettings, "provider" | "baseUrl" | "secondaryProvider" | "secondaryBaseUrl">): string[] {
  const hosts: string[] = [];
  if (settings.provider !== "none" && !isLocalUrl(settings.baseUrl)) hosts.push(urlHost(settings.baseUrl) ?? settings.baseUrl);
  if (settings.secondaryProvider !== "none" && !isLocalUrl(settings.secondaryBaseUrl)) {
    hosts.push(urlHost(settings.secondaryBaseUrl) ?? settings.secondaryBaseUrl);
  }
  return hosts;
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

/** Como cada ponto age (ver `docs/agentes/JEV.md`, tabela dos pontos): os selos da prancheta 7. */
export type PointMode = "shadow" | "help" | "suggest" | "decide";

export const POINT_MODE: Record<string, PointMode> = {
  memory_approval: "shadow",
  dream_triage: "shadow",
  fleet_gate: "shadow",
  mission_gate: "shadow",
  delivery_gate: "help",
  memory_relevance: "help",
  turn_routing: "suggest",
  browser_step: "decide",
  browser_vision: "decide",
};

export interface ShadowSummary {
  /** Concordância ponderada pelos casos comparados; `null` sem comparação. */
  agreement: number | null;
  /** O pior p50 e o pior p95 entre os pontos (ms). */
  p50Ms: number | null;
  p95Ms: number | null;
  /** Erros ponderados pelo total de consultas; `null` sem consulta. */
  errorRate: number | null;
  /** Casos comparados, somados. */
  sample: number;
}

/** O resumo do relatório do modo sombra (o cartão da direita no chat). Pura. */
export function shadowSummary(points: { total: number; compared: number; agreementRate: number; p50Ms: number | null; p95Ms: number | null; errorRate: number }[]): ShadowSummary {
  const sample = points.reduce((n, p) => n + p.compared, 0);
  const total = points.reduce((n, p) => n + p.total, 0);
  const worst = (pick: (p: (typeof points)[number]) => number | null) =>
    points.reduce<number | null>((max, p) => { const v = pick(p); return v === null ? max : max === null ? v : Math.max(max, v); }, null);
  return {
    agreement: sample > 0 ? points.reduce((n, p) => n + p.agreementRate * p.compared, 0) / sample : null,
    p50Ms: worst((p) => p.p50Ms),
    p95Ms: worst((p) => p.p95Ms),
    errorRate: total > 0 ? points.reduce((n, p) => n + p.errorRate * p.total, 0) / total : null,
    sample,
  };
}
