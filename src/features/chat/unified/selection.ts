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

const SPECIAL_SEPS = ["#m:", "#c:", "#cmp:"];
const isSpecialKey = (key: string) => SPECIAL_SEPS.some((sep) => key.includes(sep));

export interface HomeContext {
  boards: Record<string, Pick<Board, "nodes" | "threads">>;
  cwd: string;
  /** Onde mora a coroa do time (`UnifiedConversation.boardKey`), quando a conversa é de um. */
  teamBoardKey?: string;
  /** A chave do canvas de uma pasta. */
  cwdKey: (cwd: string) => string;
}

/**
 * O canvas em que a conversa mora: o que já tem um nó dela (o especial, de missão ou de conversa de
 * projeto, vence o da pasta); senão onde está a coroa do time; senão o da pasta do `cwd`. Pura.
 */
export function homeBoardKey(ref: string, ctx: HomeContext): string {
  let found: string | null = null;
  for (const [key, board] of Object.entries(ctx.boards)) {
    if (!(ref in (board.threads ?? {})) && !(ref in board.nodes)) continue;
    if (found === null || (isSpecialKey(key) && !isSpecialKey(found))) found = key;
  }
  return found ?? ctx.teamBoardKey ?? ctx.cwdKey(ctx.cwd);
}
