/** El buscador de texto del panel derecho. Ver `explorer/search.rs`. */
import { invoke } from "@tauri-apps/api/core";

export interface SearchOptions {
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** Globs separados por coma. */
  include: string;
  exclude: string;
}

export interface SearchMatch {
  line: number;
  /** En unidades UTF-16, como las usa CodeMirror. */
  column: number;
  preview: string;
  start: number;
  end: number;
}

export interface FileMatches {
  path: string;
  rel: string;
  matches: SearchMatch[];
}

export interface SearchResult {
  files: FileMatches[];
  matchCount: number;
  truncated: boolean;
  cancelled: boolean;
}

export interface QuickOpenFile {
  name: string;
  path: string;
  rel: string;
}

export interface QuickOpenResult {
  files: QuickOpenFile[];
  truncated: boolean;
  cancelled: boolean;
}

export const searchText = (root: string, query: string, options: SearchOptions) =>
  invoke<SearchResult>("explorer_search", { query: { root, query, ...options } });

/** Busca nomes respeitando `.gitignore` e os limites do walker do backend. */
export const quickOpenFiles = (root: string, query: string) =>
  invoke<QuickOpenResult>("explorer_quick_open", { query: { root, query } });
