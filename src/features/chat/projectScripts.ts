import { join } from "@tauri-apps/api/path";

import { readFile } from "@/features/editor/ipc";

import { normalizeProjectPath } from "./chatProjectPrefs";
import { projectScriptCommandGet, projectScriptCommandSave } from "./projectScriptsIpc";
import { normalizeUrl } from "@/features/tabs/viewTabs";

const STORAGE_KEY = "cc-chat-project-script-index";
const LEGACY_STORAGE_KEY = "cc-chat-project-scripts";
const WORKTREE_ROOTS_KEY = "cc-chat-project-script-worktree-roots-v1";
const MAX_SCRIPTS_PER_PROJECT = 32;
const MAX_SCRIPT_NAME = 100;
const MAX_SCRIPT_COMMAND_BYTES = 8 * 1024;

/** Metadados seguros para o localStorage; o comando nunca faz parte deste objeto. */
export interface ChatProjectScript {
  id: string;
  name: string;
  setup: boolean;
  onSettle: boolean;
  /** Só os registros gravados após o opt-in explícito do editor podem armar gatilhos. */
  automationOptInVersion: 1;
  previewUrl?: string;
}

export interface T3ProjectScriptCandidate {
  name: string;
  command: string | null;
  setup: boolean;
  onSettle: boolean;
  previewUrl: string | null;
  invalidPreviewUrl: boolean;
  containsSecret: boolean;
  tooLarge: boolean;
}

function parseScript(value: unknown): ChatProjectScript | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  if (!id || id.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(id) || !name || name.length > MAX_SCRIPT_NAME) return null;
  const previewUrl = typeof candidate.previewUrl === "string" ? normalizeProjectPreviewUrl(candidate.previewUrl) ?? undefined : undefined;
  const optedIn = candidate.automationOptInVersion === 1;
  return {
    id,
    name,
    setup: optedIn && candidate.setup === true,
    onSettle: optedIn && candidate.onSettle === true,
    automationOptInVersion: 1,
    ...(previewUrl ? { previewUrl } : {}),
  };
}

function readAll(): Record<string, ChatProjectScript[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: Record<string, ChatProjectScript[]> = {};
    for (const [path, scripts] of Object.entries(value as Record<string, unknown>)) {
      if (!path || !Array.isArray(scripts)) continue;
      const valid = scripts.map(parseScript).filter((script): script is ChatProjectScript => script !== null).slice(0, MAX_SCRIPTS_PER_PROJECT);
      result[normalizeProjectPath(path)] = valid;
    }
    return result;
  } catch {
    return {};
  }
}

export function loadChatProjectScripts(cwd: string | null): ChatProjectScript[] {
  if (!cwd) return [];
  return readAll()[normalizeProjectPath(cwd)] ?? [];
}

export function saveChatProjectScripts(cwd: string, scripts: ChatProjectScript[]): boolean {
  if (scripts.length > MAX_SCRIPTS_PER_PROJECT) return false;
  const valid = scripts.map(parseScript);
  if (valid.some((script) => script === null)) return false;
  try {
    const all = readAll();
    const path = normalizeProjectPath(cwd);
    if (scripts.length === 0) delete all[path];
    else all[path] = valid as ChatProjectScript[];
    if (Object.keys(all).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

/** Migra comandos do formato localStorage antigo para o chaveiro; mantém a origem se qualquer etapa falhar. */
export async function migrateLegacyChatProjectScripts(cwd: string): Promise<ChatProjectScript[] | null> {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("O índice antigo das ações está inválido.");
  const all = parsed as Record<string, unknown>;
  const target = Object.entries(all).find(([path]) => normalizeProjectPath(path) === normalizeProjectPath(cwd));
  if (!target) return null;
  const [legacyPath, legacyValue] = target;
  if (!Array.isArray(legacyValue)) throw new Error("A lista antiga de ações do projeto está inválida.");

  const staged = [...loadChatProjectScripts(cwd)];
  const migrated: Array<{ script: ChatProjectScript; command: string }> = [];
  for (const item of legacyValue) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Uma ação antiga está inválida; os dados originais foram preservados.");
    const candidate = item as Record<string, unknown>;
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    const command = typeof candidate.command === "string" ? candidate.command.trim() : "";
    if (!name || name.length > MAX_SCRIPT_NAME || !validProjectScriptCommand(command)) {
      throw new Error("Uma ação antiga não cabe no limite seguro de 8 KiB; os dados originais foram preservados.");
    }
    const requestedId = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const id = /^[a-zA-Z0-9_-]{1,128}$/.test(requestedId) ? requestedId : newProjectScriptId(name, staged);
    const existing = staged.find((script) => script.id === id);
    const script = existing ?? makeProjectScript(
      name,
      id,
      false,
      false,
      typeof candidate.previewUrl === "string" ? candidate.previewUrl : undefined,
    );
    if (!script) throw new Error("Não foi possível recuperar uma ação antiga; os dados originais foram preservados.");
    if (!existing) staged.push(script);
    migrated.push({ script, command });
  }

  for (const { script, command } of migrated) {
    if (await projectScriptCommandGet(cwd, script.id) === null) await projectScriptCommandSave(cwd, script.id, command);
  }
  if (!saveChatProjectScripts(cwd, staged)) throw new Error("Não foi possível salvar os nomes das ações migradas.");

  delete all[legacyPath];
  try {
    if (Object.keys(all).length === 0) localStorage.removeItem(LEGACY_STORAGE_KEY);
    else localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // A cópia protegida já existe; manter a entrada antiga é mais seguro que perder a referência.
    throw new Error("As ações foram migradas, mas o índice antigo não pôde ser removido do armazenamento local.");
  }
  return staged;
}

export function makeProjectScript(name: string, id: string = crypto.randomUUID(), setup = false, onSettle = false, previewUrl?: string): ChatProjectScript | null {
  const normalizedPreview = previewUrl?.trim() ? normalizeProjectPreviewUrl(previewUrl) : undefined;
  return parseScript({ id, name, setup, onSettle, automationOptInVersion: 1, ...(normalizedPreview ? { previewUrl: normalizedPreview } : {}) });
}

/** Associa o worktree criado explicitamente à pasta de projeto que contém suas ações. */
export function registerProjectScriptWorktree(worktreeCwd: string, sourceCwd: string): void {
  try {
    const raw = localStorage.getItem(WORKTREE_ROOTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const entries = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] =>
        !!entry[0] && typeof entry[1] === "string" && entry[1].length > 0)
      : [];
    const next = Object.fromEntries(entries.filter(([path]) => path !== normalizeProjectPath(worktreeCwd)));
    next[normalizeProjectPath(worktreeCwd)] = normalizeProjectPath(sourceCwd);
    const limited = Object.fromEntries(Object.entries(next).slice(-256));
    localStorage.setItem(WORKTREE_ROOTS_KEY, JSON.stringify(limited));
  } catch {
    // A ação de criação não falha porque a preferência local não pôde ser registrada.
  }
}

/** Resolve a pasta de origem para que ações configuradas antes do worktree também apareçam no settle. */
export function projectScriptSourceCwd(cwd: string): string {
  try {
    const raw = localStorage.getItem(WORKTREE_ROOTS_KEY);
    if (!raw) return cwd;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return cwd;
    const source = (parsed as Record<string, unknown>)[normalizeProjectPath(cwd)];
    return typeof source === "string" && source.length > 0 ? source : cwd;
  } catch {
    return cwd;
  }
}

/** Previews do projeto ficam no loopback, sem credenciais, query ou fragmento persistidos. */
export function normalizeProjectPreviewUrl(input: string): string | null {
  const value = input.trim();
  if (value.length > 2_048 || value.includes("?") || value.includes("#")) return null;
  const normalized = normalizeUrl(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const ipv4 = hostname.split(".").map(Number);
    const loopback = hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1"
      || (ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && ipv4[0] === 127);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !loopback || url.username || url.password || url.search || url.hash) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function validProjectScriptCommand(command: string): boolean {
  const trimmed = command.trim();
  return trimmed.length > 0 && new TextEncoder().encode(trimmed).byteLength <= MAX_SCRIPT_COMMAND_BYTES && !trimmed.includes("\0");
}

const INLINE_SECRET_PATTERNS = [
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}/i,
  /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY)[A-Z0-9_]*\s*=\s*["']?(?!\$[\w{]|%[A-Za-z_][A-Za-z0-9_]*%|<[^>]+>)[A-Za-z0-9/+_.=-]{12,}/i,
];

/** Heurística local para impedir persistir os formatos comuns de token e segredo em comandos. */
export function projectScriptCommandContainsSecret(command: string): boolean {
  return INLINE_SECRET_PATTERNS.some((pattern) => pattern.test(command));
}

/** Lê e filtra a lista do t3.json sem executar ou persistir os comandos em claro. */
export async function readT3ProjectScripts(cwd: string): Promise<T3ProjectScriptCandidate[]> {
  const file = await readFile(await join(cwd, "t3.json"));
  if (file.kind === "tooLarge") throw new Error("O t3.json excede o limite de leitura de 5 MiB.");
  if (file.kind !== "text") throw new Error("O t3.json não é um arquivo de texto UTF-8.");
  const parsed: unknown = JSON.parse(file.content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("O t3.json precisa conter um objeto JSON.");
  const scripts = (parsed as Record<string, unknown>).scripts;
  if (!Array.isArray(scripts)) return [];
  return scripts.slice(0, 64).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const value = entry as Record<string, unknown>;
    if (typeof value.name !== "string" || typeof value.command !== "string") return [];
    const name = value.name.trim();
    const rawCommand = value.command.trim();
    if (!name || name.length > MAX_SCRIPT_NAME || !rawCommand) return [];
    const tooLarge = new TextEncoder().encode(rawCommand).byteLength > MAX_SCRIPT_COMMAND_BYTES;
    const rawPreviewUrl = typeof value.previewUrl === "string" ? value.previewUrl.trim() : "";
    const previewUrl = rawPreviewUrl ? normalizeProjectPreviewUrl(rawPreviewUrl) : null;
    return [{
      name,
      command: tooLarge ? null : rawCommand,
      setup: value.runOnWorktreeCreate === true,
      onSettle: value.runOnSettle === true,
      previewUrl,
      invalidPreviewUrl: rawPreviewUrl.length > 0 && previewUrl === null,
      containsSecret: projectScriptCommandContainsSecret(rawCommand),
      tooLarge,
    }];
  });
}

export function newProjectScriptId(name: string, existing: ChatProjectScript[]): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "script";
  const ids = new Set(existing.map((script) => script.id));
  if (!ids.has(base)) return base;
  let suffix = 2;
  while (ids.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}
