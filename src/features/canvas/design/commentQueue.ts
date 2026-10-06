import type { Artboard, DesignComment } from "./designApi";

/** Comentários do usuário ainda não resolvidos, na ordem em que foram feitos. */
export function pendingComments(comments: DesignComment[]): DesignComment[] {
  return comments.filter((c) => c.author === "user" && !c.resolved).sort((a, b) => a.createdAt - b.createdAt);
}

/** Texto único para o agente dono: um bloco por prancheta, com o seletor de cada comentário. */
export function formatQueueForAgent(designTitle: string, artboards: Artboard[], queue: DesignComment[]): string {
  const lines = [`Design "${designTitle}": comentários do usuário para atualizar as pranchetas.`];
  for (const board of artboards) {
    const mine = queue.filter((c) => c.artboardId === board.id);
    if (mine.length === 0) continue;
    lines.push(`\nPrancheta "${board.title}" (id ${board.id}, v${board.version}):`);
    for (const c of mine) lines.push(`- ${c.selector ? `[${c.selector}] ` : ""}${c.text}`);
  }
  lines.push("\nAtualize com 'ags design artboard update' e responda quando terminar.");
  return lines.join("\n");
}

/** Pedido de construção ao agente dono: só as aprovadas, com o id para ele ler o HTML de referência. */
export function formatBuildRequest(designTitle: string, designId: string, artboards: Artboard[]): string {
  const lines = [`Design "${designTitle}" (id ${designId}): o usuário aprovou estas pranchetas. Construa SOMENTE elas, cada uma no seu worktree, usando o HTML da prancheta como referência (ags design get ${designId}).`];
  for (const b of buildable(artboards)) lines.push(`- "${b.title}" (id ${b.id}, v${b.version}, ${b.width}x${b.height})`);
  lines.push("Não toque nas pranchetas rascunho ou rejeitadas.");
  return lines.join("\n");
}

/** Só pranchetas aprovadas viram construção; rascunho e rejeitada não são tocadas. */
export const buildable = (artboards: Artboard[]) => artboards.filter((a) => a.status === "approved");
export const allApproved = (artboards: Artboard[]) => artboards.length > 0 && artboards.every((a) => a.status === "approved");
