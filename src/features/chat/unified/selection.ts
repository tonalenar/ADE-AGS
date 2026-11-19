import type { Board } from "@/features/canvas/board";

import { threadKey } from "../structured/model";

/**
 * A seleção única: a ref da conversa que está à vista, a MESMA em Chat, Abas e Canvas (desenho da
 * unificação, D2). Hoje ela mora em dois lugares por história: a aba ativa (`activeTabId`, TUI) e a
 * conversa por protocolo aberta (`useChatStore.thread`). Esta função é a regra que as une: a conversa
 * por protocolo aberta vence, porque abri-la é o gesto mais recente (ativar uma aba a fecha; ver
 * `selectionActions`). Pura.
 */
export function selectedRef(s: { thread: string | null; activeTabId: string | null }): string | null {
  return s.thread ? threadKey(s.thread) : s.activeTabId;
}

const LEGACY_SPECIAL_SEPS = ["#m:", "#c:", "#cmp:"];
const SESSION_SEP = "#s:";
const isLegacySpecialKey = (key: string) => LEGACY_SPECIAL_SEPS.some((sep) => key.includes(sep));

export interface HomeContext {
  boards: Record<string, Pick<Board, "nodes" | "threads">>;
  cwd: string;
  /** Onde mora a coroa do time (`UnifiedConversation.boardKey`), quando a conversa é de um. */
  teamBoardKey?: string;
  sessionBoardKey?: string;
  /** A chave do canvas de uma pasta. */
  cwdKey: (cwd: string) => string;
}

/**
 * O canvas em que a conversa mora: o especial legado vence; depois, a coroa do time, uma sessão já
 * existente e, por último, a sessão própria no `cwd`. Pura.
 */
export function homeBoardKey(ref: string, ctx: HomeContext): string {
  let found: string | null = null;
  for (const [key, board] of Object.entries(ctx.boards)) {
    if (!(ref in (board.threads ?? {})) && !(ref in board.nodes)) continue;
    if (!isLegacySpecialKey(key) && !key.includes(SESSION_SEP)) continue;
    if (found === null || (isLegacySpecialKey(key) && !isLegacySpecialKey(found))) found = key;
  }
  if (found && isLegacySpecialKey(found)) return found;
  if (ctx.teamBoardKey) return ctx.teamBoardKey;
  return found ?? ctx.sessionBoardKey ?? `${ctx.cwdKey(ctx.cwd)}${SESSION_SEP}${ref}`;
}
