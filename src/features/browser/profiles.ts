/** Perfis do navegador nativo. Só os nomes e ids ficam no estado local da janela; cookies
 *  e demais dados do site permanecem no diretório isolado do WebView2. */

export interface BrowserProfile {
  id: string;
  name: string;
}

export const DEFAULT_BROWSER_PROFILE_ID = "default";
const STORAGE_KEY = "cc-browser-profiles-v1";
const VIEW_TABS_KEY_PREFIX = "cc-view-tabs:";
const MAX_PROFILES = 24;
const DEFAULT_PROFILE: BrowserProfile = { id: DEFAULT_BROWSER_PROFILE_ID, name: "" };

function persistProfiles(profiles: BrowserProfile[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles.filter((profile) => profile.id !== DEFAULT_BROWSER_PROFILE_ID)));
  } catch {
    throw new Error("storage");
  }
}

function normalizedName(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, 48);
}

/** Perfil persistente de uma conversa/agente, sem incorporar o identificador original ao caminho. */
export function browserProfileIdForOwner(owner: { kind: string; id: string }): string {
  const kind = owner.kind === "tab" || owner.kind === "thread" || owner.kind === "task" ? owner.kind : "other";
  const input = `${kind}:${owner.id}`;
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  return `agent-${kind}-${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

/** Lê os perfis conhecidos e descarta entradas inválidas do armazenamento local. */
export function readBrowserProfiles(): BrowserProfile[] {
  const profiles: BrowserProfile[] = [DEFAULT_PROFILE];
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(raw)) return profiles;
    const ids = new Set([DEFAULT_BROWSER_PROFILE_ID]);
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const { id, name } = item as { id?: unknown; name?: unknown };
      if (typeof id !== "string" || !/^profile-[a-f0-9-]{36}$/i.test(id) || ids.has(id)) continue;
      if (typeof name !== "string" || !name.trim() || name.length > 48) continue;
      ids.add(id);
      profiles.push({ id, name: name.trim() });
      if (profiles.length >= MAX_PROFILES) break;
    }
  } catch {
    // Armazenamento indisponível ou JSON antigo/corrompido: o perfil padrão continua utilizável.
  }
  return profiles;
}

/** Cria um perfil vazio. Não copia cookies nem lê dados de outros navegadores. */
export function createBrowserProfile(name: string): BrowserProfile {
  const normalized = normalizedName(name);
  if (!normalized) throw new Error("empty");
  const profiles = readBrowserProfiles();
  if (profiles.length >= MAX_PROFILES) throw new Error("limit");
  if (profiles.some((profile) => profile.name.localeCompare(normalized, undefined, { sensitivity: "accent" }) === 0)) {
    throw new Error("duplicate");
  }
  const profile = { id: `profile-${crypto.randomUUID()}`, name: normalized };
  persistProfiles([...profiles, profile]);
  return profile;
}

/** Renomeia apenas perfis gerenciados pela ADE; o id e a pasta de cookies permanecem iguais. */
export function renameBrowserProfile(id: string, name: string): BrowserProfile {
  const normalized = normalizedName(name);
  if (!normalized) throw new Error("empty");
  const profiles = readBrowserProfiles();
  const current = profiles.find((profile) => profile.id === id);
  if (!current || !/^profile-[a-f0-9-]{36}$/i.test(id)) throw new Error("missing");
  if (profiles.some((profile) => profile.id !== id
    && profile.name.localeCompare(normalized, undefined, { sensitivity: "accent" }) === 0)) {
    throw new Error("duplicate");
  }
  const updated = { ...current, name: normalized };
  persistProfiles(profiles.map((profile) => profile.id === id ? updated : profile));
  return updated;
}

/** Remove somente os metadados locais depois que o backend confirmar a limpeza dos dados do WebView2. */
export function removeBrowserProfile(id: string): void {
  if (!/^profile-[a-f0-9-]{36}$/i.test(id)) throw new Error("missing");
  const profiles = readBrowserProfiles();
  if (!profiles.some((profile) => profile.id === id)) throw new Error("missing");
  persistProfiles(profiles.filter((profile) => profile.id !== id));
}

/** Perfis usados por abas abertas/restauráveis não podem ser removidos até serem desassociados. */
export function browserProfileIsReferenced(id: string, views: readonly { kind?: string; browserProfileId?: string }[]): boolean {
  const referencesProfile = (candidate: unknown) => Array.isArray(candidate)
    && candidate.some((view) => view && typeof view === "object"
      && (view as { kind?: unknown; browserProfileId?: unknown }).kind === "browser"
      && (view as { browserProfileId?: unknown }).browserProfileId === id);

  if (referencesProfile(views)) return true;
  try {
    // Cada janela persiste suas próprias abas; consultar as chaves locais também protege
    // as janelas que estão fechadas e serão restauradas depois.
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(VIEW_TABS_KEY_PREFIX)) continue;
      try {
        if (referencesProfile(JSON.parse(localStorage.getItem(key) ?? "null"))) return true;
      } catch {
        // Uma lista antiga/corrompida não bloqueia o gerenciamento dos demais perfis.
      }
    }
  } catch {
    // Se o armazenamento estiver indisponível, ainda vale a checagem em memória e no backend.
  }
  return false;
}
