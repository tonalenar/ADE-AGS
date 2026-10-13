/**
 * Andares: o que as telas de criar e de aterrissar precisam decidir, sem React. O git em si (listar branches,
 * contar commits, fundir) é do backend (`floors_land.rs`); aqui só se lê o que ele devolveu.
 */

export interface BranchInfo {
  name: string;
  current: boolean;
  /** Já está em outro worktree: o git não deixa a mesma branch em dois lugares. */
  inUse: boolean;
}

export interface CommitLine {
  sha: string;
  subject: string;
}

export interface LandPreview {
  branch: string;
  target: string;
  /** Commits do andar que o alvo ainda não tem. */
  ahead: number;
  /** Commits do alvo que o andar ainda não tem. */
  behind: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** O andar tem mudanças que não foram commitadas. */
  dirty: boolean;
  conflicts: string[];
  /** O git sabia simular a fusão; sem isso, "sem conflitos" não é garantia. */
  conflictsChecked: boolean;
  commits: CommitLine[];
}

export interface LandResult {
  merged: boolean;
  commits: number;
  branchDeleted: boolean;
  floorRemoved: boolean;
}

/** Em que pé está o andar para aterrissar: nada a levar, mudanças soltas, conflito ou pronto. Pura. */
export type LandState = "nothing" | "dirty" | "conflict" | "ready";

export function landState(preview: LandPreview): LandState {
  if (preview.dirty) return "dirty";
  if (preview.ahead === 0) return "nothing";
  if (preview.conflicts.length > 0) return "conflict";
  return "ready";
}

/** Só se aterrissa um andar pronto: sem sujeira, com o que levar e sem conflito. Pura. */
export function canLand(preview: LandPreview | null): boolean {
  return preview !== null && landState(preview) === "ready";
}

/** As branches que o campo de busca deixa ver: a atual primeiro, depois por nome; casa em qualquer parte. Pura. */
export function filterBranches(list: BranchInfo[], query: string): BranchInfo[] {
  const needle = query.trim().toLowerCase();
  return list
    .filter((b) => !needle || b.name.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
}

/** A origem padrão de um andar novo: a branch atual do projeto, ou a primeira da lista. Pura. */
export function defaultStart(list: BranchInfo[]): string {
  return (list.find((b) => b.current) ?? list[0])?.name ?? "HEAD";
}

/**
 * As pastas a deixar de fora da cópia, escritas separadas por vírgula ou linha. Só caminhos relativos e
 * dentro do projeto: nada de `..`, de raiz ou de unidade (`C:`). Pura.
 */
export function parseExcluded(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[\n,]/)) {
    const value = part.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!value || value.startsWith("/") || /^[a-zA-Z]:/.test(value) || value.split("/").includes("..")) continue;
    seen.add(value);
  }
  return [...seen];
}

/** O texto que pede a um agente para tirar os conflitos de dentro do andar (e não do projeto). Pura. */
export function conflictPrompt(floorName: string, preview: LandPreview): string {
  const files = preview.conflicts.length > 0 ? `\nArquivos em conflito:\n${preview.conflicts.map((f) => `- ${f}`).join("\n")}\n` : "\n";
  return [
    `Você está no andar "${floorName}" (branch ${preview.branch}). Ele não pode ser aterrissado em ${preview.target} porque a fusão tem conflitos.`,
    files,
    `Traga o que mudou em ${preview.target} para esta branch com \`git merge ${preview.target}\`, resolva os conflitos preservando o trabalho dos dois lados, rode os testes do que mexeu e faça o commit da fusão.`,
    "Não use push --force, não reescreva commits e não mexa fora deste andar. Quando terminar, diga que o andar está pronto para aterrissar.",
  ].join("\n");
}

/** O resumo curto de um andar para o cartão: o que há para levar e se tem sujeira. Pura. */
export function floorBadge(preview: LandPreview | null): { kind: "unknown" | "clean" | "dirty" | "ahead" | "conflict"; ahead: number } {
  if (!preview) return { kind: "unknown", ahead: 0 };
  if (preview.dirty) return { kind: "dirty", ahead: preview.ahead };
  if (preview.conflicts.length > 0) return { kind: "conflict", ahead: preview.ahead };
  return { kind: preview.ahead > 0 ? "ahead" : "clean", ahead: preview.ahead };
}
