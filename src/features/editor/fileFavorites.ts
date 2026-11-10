/** Favoritos de arquivo locais à ADE, indexados pela raiz normalizada do workspace. */

const STORAGE_KEY = "cc-editor-file-favorites";
const STORAGE_VERSION = 1;

type FavoriteMap = Record<string, string[]>;

interface StoredFavorites {
  version: number;
  workspaces: FavoriteMap;
}

type ReadResult =
  | { status: "ok"; value: StoredFavorites; writable: true }
  | { status: "unavailable" | "invalid"; value: StoredFavorites; writable: false }
  | { status: "future"; value: StoredFavorites; writable: false };

export type FileFavoriteMutationStatus =
  | "added"
  | "removed"
  | "unchanged"
  | "invalid-path"
  | "storage-unavailable"
  | "invalid-preferences"
  | "unsupported-version";

export interface FileFavoriteMutation {
  status: FileFavoriteMutationStatus;
  /** Estado final do caminho, inclusive quando a mutação não pôde ser gravada. */
  isFavorite: boolean;
}

const EMPTY: StoredFavorites = { version: STORAGE_VERSION, workspaces: {} };

interface AbsolutePath {
  root: string;
  segments: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function pathParts(raw: string): string[] {
  return raw.replace(/\\/g, "/").split("/").filter(Boolean);
}

function parseAbsolutePath(raw: string): AbsolutePath | null {
  const path = raw.replace(/\\/g, "/");
  if (path.includes("\0")) return null;
  let root: string;
  let tail: string;

  const drive = /^([a-zA-Z]:)\//.exec(path);
  if (drive) {
    root = `${drive[1]!.toUpperCase()}/`;
    tail = path.slice(drive[0].length);
  } else if (path.startsWith("//")) {
    const parts = pathParts(path.slice(2));
    if (parts.length < 2) return null;
    root = `//${parts[0]}/${parts[1]}/`;
    tail = parts.slice(2).join("/");
  } else if (path.startsWith("/")) {
    root = "/";
    tail = path;
  } else {
    return null;
  }

  const segments: string[] = [];
  for (const segment of pathParts(tail)) {
    if (segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    if (segment.includes("\0")) return null;
    segments.push(segment);
  }
  return { root, segments };
}

function comparisonPath(path: AbsolutePath): string {
  const value = `${path.root}${path.segments.join("/")}`;
  // Caminhos Windows não diferenciam maiúsculas e minúsculas.
  return /^[a-zA-Z]:\//.test(path.root) || path.root.startsWith("//") ? value.toLowerCase() : value;
}

function workspaceKey(workspaceRoot: string): { key: string; path: AbsolutePath } | null {
  const path = parseAbsolutePath(workspaceRoot);
  if (!path) return null;
  return { key: comparisonPath(path), path };
}

/**
 * Normaliza um caminho de arquivo para uma forma relativa ao workspace.
 * Aceita entrada relativa ou absoluta; retorna `null` se ela não for válida ou escapar da raiz.
 * A validação é lexical: ela não resolve links simbólicos do sistema de arquivos.
 */
export function normalizeFileFavoritePath(workspaceRoot: string, candidatePath: string): string | null {
  const workspace = workspaceKey(workspaceRoot);
  if (!workspace || !candidatePath || candidatePath.includes("\0")) return null;

  const candidate = candidatePath.replace(/\\/g, "/");
  let relativeSegments: string[];
  const absolute = parseAbsolutePath(candidate);

  if (absolute) {
    const rootMatches = comparisonPath({ root: absolute.root, segments: [] }) === comparisonPath({ root: workspace.path.root, segments: [] });
    if (!rootMatches || absolute.segments.length < workspace.path.segments.length) return null;
    const workspacePrefix = workspace.path.segments;
    const candidatePrefix = absolute.segments.slice(0, workspacePrefix.length);
    const caseInsensitive = /^[a-zA-Z]:\//.test(workspace.path.root) || workspace.path.root.startsWith("//");
    const matches = candidatePrefix.every((segment, index) => caseInsensitive
      ? segment.toLowerCase() === workspacePrefix[index]!.toLowerCase()
      : segment === workspacePrefix[index]);
    if (!matches) return null;
    relativeSegments = absolute.segments.slice(workspacePrefix.length);
  } else {
    // Um caminho que parece absoluto, mas não é uma raiz reconhecida, não pode ser relativo.
    if (candidate.startsWith("/") || /^[a-zA-Z]:/.test(candidate)) return null;
    relativeSegments = [];
    for (const segment of pathParts(candidate)) {
      if (segment === ".") continue;
      if (segment === "..") {
        if (relativeSegments.length === 0) return null;
        relativeSegments.pop();
      } else {
        relativeSegments.push(segment);
      }
    }
  }

  if (relativeSegments.length === 0 || relativeSegments.some((segment) => segment === ".." || segment.includes("\0"))) return null;
  return relativeSegments.join("/");
}

function normalizeStoredRelativePath(path: string): string | null {
  if (!path || path.includes("\0") || path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return null;
  const segments: string[] = [];
  for (const segment of pathParts(path)) {
    if (segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.length ? segments.join("/") : null;
}

function cleanWorkspaces(value: unknown): FavoriteMap {
  if (!isRecord(value)) return {};
  const result: FavoriteMap = {};
  for (const [rawWorkspace, rawPaths] of Object.entries(value)) {
    const workspace = workspaceKey(rawWorkspace);
    if (!workspace || !Array.isArray(rawPaths)) continue;
    const paths = [...new Set(rawPaths.filter((item): item is string => typeof item === "string")
      .map(normalizeStoredRelativePath)
      .filter((item): item is string => item !== null))];
    if (paths.length) result[workspace.key] = paths;
  }
  return result;
}

function readFavorites(): ReadResult {
  if (typeof localStorage === "undefined") return { status: "unavailable", value: EMPTY, writable: false };

  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return { status: "unavailable", value: EMPTY, writable: false };
  }
  if (raw === null) return { status: "ok", value: EMPTY, writable: true };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Mantém o valor corrompido intacto; a próxima escrita não o sobrescreve silenciosamente.
    return { status: "invalid", value: EMPTY, writable: false };
  }
  if (!isRecord(parsed)) return { status: "invalid", value: EMPTY, writable: false };

  const version = parsed.version;
  if (version !== undefined && (typeof version !== "number" || !Number.isInteger(version) || version < 0)) {
    return { status: "invalid", value: EMPTY, writable: false };
  }
  if (typeof version === "number" && version > STORAGE_VERSION) {
    return { status: "future", value: { version, workspaces: cleanWorkspaces(parsed.workspaces) }, writable: false };
  }
  if (version !== undefined && version !== 0 && version !== STORAGE_VERSION) {
    return { status: "invalid", value: EMPTY, writable: false };
  }

  // Compatibilidade com formatos anteriores: envelope sem versão, mapa direto ou versão 0.
  let rawWorkspaces = parsed.workspaces;
  if (rawWorkspaces === undefined && (version === undefined || version === 0)) {
    rawWorkspaces = { ...parsed };
    delete (rawWorkspaces as Record<string, unknown>).version;
  }
  if (!isRecord(rawWorkspaces)) return { status: "invalid", value: EMPTY, writable: false };
  const workspaces = cleanWorkspaces(rawWorkspaces);
  return { status: "ok", value: { version: STORAGE_VERSION, workspaces }, writable: true };
}

/** Lista caminhos relativos normalizados e válidos para a raiz informada. */
export function listFileFavorites(workspaceRoot: string): string[] {
  const workspace = workspaceKey(workspaceRoot);
  if (!workspace) return [];
  const read = readFavorites();
  return [...(read.value.workspaces[workspace.key] ?? [])];
}

function mutateFavorite(workspaceRoot: string, candidatePath: string, action: "add" | "remove" | "toggle"): FileFavoriteMutation {
  const workspace = workspaceKey(workspaceRoot);
  const relativePath = normalizeFileFavoritePath(workspaceRoot, candidatePath);
  if (!workspace || !relativePath) return { status: "invalid-path", isFavorite: false };

  const read = readFavorites();
  if (!read.writable) {
    return {
      status: read.status === "unavailable" ? "storage-unavailable"
        : read.status === "future" ? "unsupported-version" : "invalid-preferences",
      isFavorite: (read.value.workspaces[workspace.key] ?? []).includes(relativePath),
    };
  }

  const current = read.value.workspaces[workspace.key] ?? [];
  const exists = current.includes(relativePath);
  const shouldExist = action === "toggle" ? !exists : action === "add";
  if (shouldExist === exists) return { status: "unchanged", isFavorite: exists };

  const nextPaths = shouldExist ? [...current, relativePath] : current.filter((path) => path !== relativePath);
  const workspaces = { ...read.value.workspaces };
  if (nextPaths.length) workspaces[workspace.key] = nextPaths;
  else delete workspaces[workspace.key];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, workspaces }));
  } catch {
    return { status: "storage-unavailable", isFavorite: exists };
  }
  return { status: shouldExist ? "added" : "removed", isFavorite: shouldExist };
}

/** Adiciona um caminho se ainda não estiver favoritado. */
export function addFileFavorite(workspaceRoot: string, candidatePath: string): FileFavoriteMutation {
  return mutateFavorite(workspaceRoot, candidatePath, "add");
}

/** Remove um caminho favoritado. */
export function removeFileFavorite(workspaceRoot: string, candidatePath: string): FileFavoriteMutation {
  return mutateFavorite(workspaceRoot, candidatePath, "remove");
}

/** Alterna o favorito e devolve o estado final em `isFavorite`. */
export function toggleFileFavorite(workspaceRoot: string, candidatePath: string): FileFavoriteMutation {
  return mutateFavorite(workspaceRoot, candidatePath, "toggle");
}
