import type { ChatAccess } from "./chatModel";
import type { ChatPrefs } from "./chatPrefs";
import type { ChatWorktreeSubmodules } from "./chatWorkspacePrefs";

/** Preferências de conversa que podem ser definidas por projeto. Conta e aparência ficam fora. */
export type ChatProjectDefaults = Pick<ChatPrefs,
  "agentId" | "model" | "effort" | "access" | "plan" | "fastMode" | "worktree" | "worktreeSubmodules" | "structured"
>;

export type ChatProjectDefaultField = keyof ChatProjectDefaults;

export interface ChatProjectPrefsSnapshot {
  /** Só os campos que realmente vêm do projeto. Os ausentes herdam a preferência da máquina. */
  defaults: Partial<ChatProjectDefaults> | null;
  /** Campos efetivamente fixados pelo projeto, incluindo snapshots legados válidos. */
  projectFields: ChatProjectDefaultField[];
  /** Campos redefinidos para herdar da máquina, anulando snapshots legados. */
  inheritedFields: ChatProjectDefaultField[];
  hasLegacyDefaults: boolean;
  hasDefaults: boolean;
  /** O formato local não pôde ser lido com segurança; ações de escrita devem ser desativadas. */
  storageError: boolean;
}

const LEGACY_STORAGE_KEY = "cc-chat-project-defaults";
const OVERRIDES_STORAGE_KEY = "cc-chat-project-overrides-v1";
const VERSION = 1;

const PROJECT_FIELDS: readonly ChatProjectDefaultField[] = [
  "agentId", "model", "effort", "access", "plan", "fastMode", "worktree", "worktreeSubmodules", "structured",
];

interface ProjectOverrideEntry {
  values: Partial<ChatProjectDefaults>;
  inherit: ChatProjectDefaultField[];
}

type OverrideStoreState =
  | { kind: "missing"; projects: Record<string, ProjectOverrideEntry> }
  | { kind: "valid"; projects: Record<string, ProjectOverrideEntry> }
  | { kind: "unreadable" | "corrupt" | "unsupported"; projects: Record<string, ProjectOverrideEntry> };

const stringOrNull = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === "string" && value.length > 0 ? value : undefined;

/** Normaliza separadores e barras finais sem alterar a grafia real do caminho. */
export function normalizeProjectPath(cwd: string): string {
  const path = cwd.replace(/\\/g, "/");
  if (/^[A-Za-z]:\/$/.test(path)) return path;
  const withoutTrailingSlashes = path.replace(/\/+$/, "");
  return withoutTrailingSlashes || (path.startsWith("/") ? "/" : "");
}

/** Valida snapshots completos para compatibilidade com consumidores antigos da função. */
export function parseChatProjectDefaults(raw: unknown): ChatProjectDefaults | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const access: ChatAccess = value.access === "ask" || value.access === "edits" || value.access === "full" ? value.access : "safe";
  return {
    agentId: stringOrNull(value.agentId) ?? null,
    model: stringOrNull(value.model) ?? null,
    effort: stringOrNull(value.effort) ?? null,
    access,
    plan: value.plan === true,
    fastMode: value.fastMode === true,
    worktree: value.worktree === true,
    worktreeSubmodules: value.worktreeSubmodules === "recursive" || value.worktreeSubmodules === "top-level" || value.worktreeSubmodules === "none"
      ? value.worktreeSubmodules as ChatWorktreeSubmodules
      : "none",
    structured: value.structured !== false,
  };
}

function isProjectField(value: unknown): value is ChatProjectDefaultField {
  return typeof value === "string" && PROJECT_FIELDS.includes(value as ChatProjectDefaultField);
}

function isValidFieldValue(field: ChatProjectDefaultField, value: unknown): boolean {
  switch (field) {
    case "agentId":
    case "model":
    case "effort":
      return value === null || (typeof value === "string" && value.length > 0);
    case "access":
      return value === "ask" || value === "safe" || value === "edits" || value === "full";
    case "plan":
    case "fastMode":
    case "worktree":
    case "structured":
      return typeof value === "boolean";
    case "worktreeSubmodules":
      return value === "recursive" || value === "top-level" || value === "none";
  }
}

function parseLegacyProjectDefaults(raw: unknown): Partial<ChatProjectDefaults> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const defaults: Partial<ChatProjectDefaults> = {};
  for (const field of PROJECT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, field) || !isValidFieldValue(field, source[field])) continue;
    (defaults as Record<string, unknown>)[field] = source[field];
  }
  return Object.keys(defaults).length > 0 ? defaults : null;
}

function readLegacyAll(): Record<string, Partial<ChatProjectDefaults>> {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: Record<string, Partial<ChatProjectDefaults>> = {};
    for (const [path, candidate] of Object.entries(value as Record<string, unknown>)) {
      const defaults = parseLegacyProjectDefaults(candidate);
      if (path && defaults) result[normalizeProjectPath(path)] = defaults;
    }
    return result;
  } catch {
    return {};
  }
}

function parseOverrideEntry(raw: unknown): ProjectOverrideEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.values !== undefined && (!record.values || typeof record.values !== "object" || Array.isArray(record.values))) return null;
  if (record.inherit !== undefined && !Array.isArray(record.inherit)) return null;

  const values: Partial<ChatProjectDefaults> = {};
  const rawValues = (record.values ?? {}) as Record<string, unknown>;
  for (const [field, value] of Object.entries(rawValues)) {
    if (!isProjectField(field) || !isValidFieldValue(field, value)) return null;
    (values as Record<string, unknown>)[field] = value;
  }
  const rawInherit = (record.inherit ?? []) as unknown[];
  if (rawInherit.some((field) => !isProjectField(field))) return null;
  const inherit = [...new Set(rawInherit as ChatProjectDefaultField[])];
  return { values, inherit };
}

function readOverridesState(): OverrideStoreState {
  let raw: string | null;
  try {
    raw = localStorage.getItem(OVERRIDES_STORAGE_KEY);
  } catch {
    return { kind: "unreadable", projects: {} };
  }
  if (raw === null) return { kind: "missing", projects: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt", projects: {} };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "corrupt", projects: {} };
  const root = parsed as Record<string, unknown>;
  if (root.version !== VERSION) return { kind: "unsupported", projects: {} };
  if (!root.projects || typeof root.projects !== "object" || Array.isArray(root.projects)) return { kind: "corrupt", projects: {} };

  const projects: Record<string, ProjectOverrideEntry> = {};
  for (const [path, rawEntry] of Object.entries(root.projects as Record<string, unknown>)) {
    const entry = parseOverrideEntry(rawEntry);
    if (!entry) return { kind: "corrupt", projects: {} };
    projects[normalizeProjectPath(path)] = entry;
  }
  return { kind: "valid", projects };
}

function isEmptyEntry(entry: ProjectOverrideEntry): boolean {
  return Object.keys(entry.values).length === 0 && entry.inherit.length === 0;
}

function writeEntry(cwd: string, entry: ProjectOverrideEntry): boolean {
  const state = readOverridesState();
  if (state.kind !== "missing" && state.kind !== "valid") return false;
  try {
    const projects = state.projects;
    const path = normalizeProjectPath(cwd);
    if (isEmptyEntry(entry)) delete projects[path];
    else projects[path] = entry;
    if (Object.keys(projects).length === 0) localStorage.removeItem(OVERRIDES_STORAGE_KEY);
    else localStorage.setItem(OVERRIDES_STORAGE_KEY, JSON.stringify({ version: VERSION, projects }));
    return true;
  } catch {
    return false;
  }
}

export function loadChatProjectSettings(cwd: string | null): ChatProjectPrefsSnapshot {
  if (!cwd) return { defaults: null, projectFields: [], inheritedFields: [], hasLegacyDefaults: false, hasDefaults: false, storageError: false };
  const path = normalizeProjectPath(cwd);
  const legacy = readLegacyAll()[path] ?? null;
  const overrideState = readOverridesState();
  const overrides = overrideState.kind === "valid" ? overrideState.projects[path] : undefined;
  const inherited = new Set(overrides?.inherit ?? []);
  const defaults: Partial<ChatProjectDefaults> = legacy ? { ...legacy } : {};

  for (const field of PROJECT_FIELDS) {
    if (inherited.has(field)) {
      delete defaults[field];
      continue;
    }
    if (overrides && Object.prototype.hasOwnProperty.call(overrides.values, field)) {
      (defaults as Record<string, unknown>)[field] = overrides.values[field];
    }
  }

  const projectFields = PROJECT_FIELDS.filter((field) =>
    !inherited.has(field) && (
      !!overrides && Object.prototype.hasOwnProperty.call(overrides.values, field)
      || !!legacy && Object.prototype.hasOwnProperty.call(legacy, field)
    ),
  );
  const hasLegacyDefaults = legacy !== null;
  const hasDefaults = projectFields.length > 0 || hasLegacyDefaults;
  return {
    defaults: Object.keys(defaults).length > 0 ? defaults : null,
    projectFields: [...projectFields],
    inheritedFields: [...inherited],
    hasLegacyDefaults,
    hasDefaults,
    storageError: overrideState.kind === "unreadable" || overrideState.kind === "corrupt" || overrideState.kind === "unsupported",
  };
}

export function loadChatProjectDefaults(cwd: string | null): Partial<ChatProjectDefaults> | null {
  return loadChatProjectSettings(cwd).defaults;
}

/** Salva um snapshot completo novo usando o formato versionado de overrides. */
export function saveChatProjectDefaults(cwd: string, prefs: ChatPrefs): boolean {
  const defaults: ChatProjectDefaults = {
    agentId: prefs.agentId,
    model: prefs.model,
    effort: prefs.effort,
    access: prefs.access,
    plan: prefs.plan,
    fastMode: prefs.fastMode,
    worktree: prefs.worktree,
    worktreeSubmodules: prefs.worktreeSubmodules ?? "none",
    structured: prefs.structured,
  };
  return writeEntry(cwd, { values: defaults, inherit: [] });
}

export function saveChatProjectField<K extends ChatProjectDefaultField>(cwd: string, field: K, value: ChatProjectDefaults[K]): boolean {
  const state = readOverridesState();
  if (state.kind !== "missing" && state.kind !== "valid") return false;
  const entry = state.projects[normalizeProjectPath(cwd)] ?? { values: {}, inherit: [] };
  entry.values[field] = value;
  entry.inherit = entry.inherit.filter((candidate) => candidate !== field);
  return writeEntry(cwd, entry);
}

/** Remove o valor deste campo; snapshots legados são ignorados para ele e a máquina volta a valer. */
export function inheritChatProjectField(cwd: string, field: ChatProjectDefaultField): boolean {
  const state = readOverridesState();
  if (state.kind !== "missing" && state.kind !== "valid") return false;
  const entry = state.projects[normalizeProjectPath(cwd)] ?? { values: {}, inherit: [] };
  delete entry.values[field];
  const hasLegacyValue = Object.prototype.hasOwnProperty.call(readLegacyAll()[normalizeProjectPath(cwd)] ?? {}, field);
  entry.inherit = hasLegacyValue
    ? [...new Set([...entry.inherit, field])]
    : entry.inherit.filter((candidate) => candidate !== field);
  return writeEntry(cwd, entry);
}

/** Oculta primeiro qualquer snapshot antigo; só então tenta apagar o legado, sem perda em falha parcial. */
export function clearChatProjectDefaults(cwd: string): boolean {
  if (!writeEntry(cwd, { values: {}, inherit: [...PROJECT_FIELDS] })) return false;
  const path = normalizeProjectPath(cwd);
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const legacy = { ...(parsed as Record<string, unknown>) };
        for (const legacyPath of Object.keys(legacy)) {
          if (normalizeProjectPath(legacyPath) === path) delete legacy[legacyPath];
        }
        if (Object.keys(legacy).length === 0) localStorage.removeItem(LEGACY_STORAGE_KEY);
        else localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(legacy));
        // Os marcadores continuam válidos se não der para remover o registro legado.
        const cleaned = readLegacyAll()[path] === undefined;
        if (cleaned) writeEntry(cwd, { values: {}, inherit: [] });
      }
    } else {
      writeEntry(cwd, { values: {}, inherit: [] });
    }
  } catch {
    // Os marcadores já foram gravados; o legado continua armazenado, mas não afeta os defaults ativos.
  }
  return true;
}
