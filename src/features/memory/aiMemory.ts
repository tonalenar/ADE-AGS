/**
 * Helpers puros do painel "Memória" com o ai-memory externo (somente leitura). Os formatos vêm do CLI
 * 3.3.0: `search --json` devolve o snippet com `<mark>…</mark>` em volta dos termos achados. Nada aqui
 * usa innerHTML: o snippet vira segmentos de texto, e o React mostra cada um como texto puro.
 */

export interface AiMemorySnippetSegment {
  text: string;
  /** true dentro de um `<mark>`: o painel destaca esse trecho. */
  highlight: boolean;
}

// Qualquer tag, de abertura ou de fechamento; as que não são `<mark>` somem, o texto dentro fica.
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g;

/**
 * Converte o snippet do ai-memory em segmentos. Só `<mark>` vira destaque; as outras tags são
 * descartadas e o texto delas é mantido. Segmentos vizinhos com o mesmo destaque são fundidos.
 */
export function parseSnippet(snippet: string): AiMemorySnippetSegment[] {
  const out: AiMemorySnippetSegment[] = [];
  const push = (text: string, highlight: boolean) => {
    if (!text) return;
    const prev = out[out.length - 1];
    if (prev && prev.highlight === highlight) prev.text += text;
    else out.push({ text, highlight });
  };

  let highlight = false;
  let last = 0;
  for (const m of snippet.matchAll(TAG)) {
    push(snippet.slice(last, m.index), highlight);
    last = m.index + m[0].length;
    if (m[2].toLowerCase() === "mark") highlight = m[1] === "";
  }
  push(snippet.slice(last), highlight);
  return out;
}

/** Data e hora de `created_at_ms` no fuso dado (o padrão é o da máquina). Vazio se o instante for inválido. */
export function formatCreatedAt(ms: number, locale: string, timeZone?: string): string {
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short", timeZone }).format(new Date(ms));
}

/** Um handoff pendente como o `ai-memory handoffs --json` devolve (só estes campos, sem resumo). */
export interface AiMemoryHandoff {
  id: string;
  from_agent: string;
  /** null quando o handoff não tem destinatário certo. */
  to_agent: string | null;
  /** null quando o handoff não registrou a pasta (o CLI 3.3.0 manda `cwd: null`). */
  cwd: string | null;
  created_at_ms: number;
}

export interface AiMemoryHandoffGroup {
  /** null agrupa os handoffs sem destinatário. */
  toAgent: string | null;
  /** Do mais antigo para o mais novo. */
  handoffs: AiMemoryHandoff[];
}

/** Agrupa por `to_agent`: os nomeados em ordem alfabética e, por último, os sem destinatário. Não altera a entrada. */
export function groupPendingHandoffs(list: readonly AiMemoryHandoff[]): AiMemoryHandoffGroup[] {
  const byAgent = new Map<string | null, AiMemoryHandoff[]>();
  for (const handoff of list) {
    const key = handoff.to_agent || null;
    const bucket = byAgent.get(key) ?? [];
    bucket.push(handoff);
    byAgent.set(key, bucket);
  }

  const groups = [...byAgent].map(([toAgent, handoffs]) => ({
    toAgent,
    handoffs: [...handoffs].sort((a, b) => a.created_at_ms - b.created_at_ms || a.id.localeCompare(b.id)),
  }));
  return groups.sort((a, b) => {
    if (a.toAgent === null) return 1;
    if (b.toAgent === null) return -1;
    return a.toAgent.localeCompare(b.toAgent);
  });
}

// Tipos do conector Rust (`src-tauri/src/ai_memory/types.rs`); contrato em docs/ade-ags/AI_MEMORY_CONNECTOR.md.

/** Tudo que vem do ai-memory chega neste envelope: é dado não confiável, mostrado só como texto. */
export interface AiMemoryUntrusted<T> {
  source: "ai-memory";
  trust: "UNTRUSTED";
  data: T;
}

export interface AiMemoryCounts {
  pages_latest: number;
  pages_all: number;
  sessions: number;
  observations: number;
}

export interface AiMemoryProvider {
  status: string;
  provider: string | null;
  model: string | null;
  dim: number | null;
}

export interface AiMemoryStatus {
  version: string;
  counts: AiMemoryCounts;
  client: { version: string } | null;
  providers: { embedding: AiMemoryProvider | null; llm: AiMemoryProvider | null } | null;
  capture_mode: string | null;
}

export type AiMemoryProbeState = "missing" | "outdated" | "server_down" | "ok";

export interface AiMemoryProbe {
  state: AiMemoryProbeState;
  version: string | null;
  installation_instruction: string | null;
  status: AiMemoryStatus | null;
  sessions_supported: boolean;
}

export interface AiMemoryRecentPage {
  path: string;
  title: string;
  snippet: string;
  updated_at: string;
  workspace: string | null;
  project: string | null;
}

export interface AiMemoryPage {
  path: string;
  workspace: string;
  project: string;
  title: string | null;
  body: string;
  frontmatter: unknown;
  expired: boolean;
}

export interface AiMemoryProject {
  workspace_id: string | null;
  workspace_name: string;
  project_id: string | null;
  project_name: string;
  page_count: number;
  last_updated: string | null;
}

export interface AiMemorySession {
  session_id: string;
  agent_kind: string;
  cwd: string | null;
  last_activity_at: string;
  /** false não prova interrupção: a sessão pode estar viva em outra aba. */
  ended: boolean;
  handed_off: boolean;
  current: boolean;
}

/** Nome da pasta (último trecho do caminho, com `/` ou `\`). */
function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * Projeto do ai-memory pré-selecionado para a pasta da aba: o de nome igual ao da pasta (sem
 * diferenciar maiúsculas); havendo mais de um, o atualizado por último. null se nenhum bater.
 */
export function guessProject(projects: readonly AiMemoryProject[], cwd: string): AiMemoryProject | null {
  const name = folderName(cwd).toLowerCase();
  if (!name) return null;
  const matches = projects.filter((p) => p.project_name.toLowerCase() === name);
  if (matches.length === 0) return null;
  return [...matches].sort((a, b) => (b.last_updated ?? "").localeCompare(a.last_updated ?? ""))[0];
}

/** Chave estável de um projeto para a escolha no painel. */
export const projectKey = (p: AiMemoryProject) => `${p.workspace_name}/${p.project_name}`;

/** Resumo de uma execução da cópia (`src-tauri/src/ai_memory/migracao.rs`). */
export interface AiMemoryMigrationSummary {
  written: number;
  skipped_secret: number;
  conflict: number;
  divergent: number;
  failed: number;
  already: number;
  /** Por que nada foi copiado (ex.: sem pasta). */
  reason: string | null;
  /** Por que a cópia parou antes do fim (ex.: servidor fora do ar). */
  stopped: string | null;
}

export type AiMemoryMigrationStatus = "written" | "skipped_secret" | "conflict" | "divergent" | "failed";

/** Uma linha do registro da cópia, sem o corpo da memória. */
export interface AiMemoryMigrationRow {
  entry_id: string;
  /** Chave da memória no ADE; ausente em backends antigos. */
  key?: string | null;
  revision: number;
  status: AiMemoryMigrationStatus | string;
  reason: string | null;
  wiki_path: string | null;
  aim_workspace: string | null;
  aim_project: string | null;
  migrated_at: number;
}

export const MIGRATION_STATUSES: readonly AiMemoryMigrationStatus[] = ["written", "skipped_secret", "conflict", "divergent", "failed"];

/** Separa o registro em copiadas e em "ficou de fora", agrupadas por status, na ordem de MIGRATION_STATUSES. */
export function splitMigrationReport(rows: readonly AiMemoryMigrationRow[]) {
  const copied = rows.filter((r) => r.status === "written");
  const left = MIGRATION_STATUSES.filter((s) => s !== "written")
    .map((status) => ({ status, rows: rows.filter((r) => r.status === status) }))
    .filter((g) => g.rows.length > 0);
  const unknown = rows.filter((r) => !MIGRATION_STATUSES.includes(r.status as AiMemoryMigrationStatus));
  if (unknown.length > 0) left.push({ status: "failed", rows: unknown });
  return { copied, left };
}
