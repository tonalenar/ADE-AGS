/** O que a página Projetos mostra para o workspace padrão: herdar do aparelho, o checkout atual ou um worktree novo. */
export type WorkspaceChoice = "inherit" | "local" | "worktree";

/** O campo `worktree` do projeto (ausente = herda) virando a escolha da tela. */
export function workspaceChoiceOf(worktree: boolean | undefined): WorkspaceChoice {
  if (worktree === undefined) return "inherit";
  return worktree ? "worktree" : "local";
}
