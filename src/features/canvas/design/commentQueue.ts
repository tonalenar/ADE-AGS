import { untrustedInline } from "@/shared/untrusted";

import type { Artboard, DesignComment } from "./designApi";

/** Comentários do usuário ainda não resolvidos, na ordem em que foram feitos. */
export function pendingComments(comments: DesignComment[]): DesignComment[] {
  return comments.filter((c) => c.author === "user" && !c.resolved).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Texto único para o agente dono: um bloco por prancheta, com o seletor de cada comentário. Título, nome e seletor
 * vêm do HTML que o agente escreveu: entram como dado numa linha. O texto do comentário é o do usuário e segue cru.
 */
export function formatQueueForAgent(designTitle: string, artboards: Artboard[], queue: DesignComment[]): string {
  const lines = [`Design ${untrustedInline("título do design", designTitle)}: comentários do usuário para atualizar as pranchetas.`];
  for (const board of artboards) {
    const mine = queue.filter((c) => c.artboardId === board.id);
    if (mine.length === 0) continue;
    lines.push(`\nPrancheta ${untrustedInline("título da prancheta", board.title)} (id ${board.id}, v${board.version}):`);
    for (const c of mine) lines.push(`- ${c.selector ? `[${untrustedInline("seletor", c.selector)}] ` : ""}${c.text}`);
  }
  lines.push("\nAtualize com 'ags design artboard update' e responda quando terminar.");
  return lines.join("\n");
}

/** Só pranchetas aprovadas viram construção; rascunho e rejeitada não são tocadas. */
export const buildable = (artboards: Artboard[]) => artboards.filter((a) => a.status === "approved");
export const allApproved = (artboards: Artboard[]) => artboards.length > 0 && artboards.every((a) => a.status === "approved");
