import type { TeamOrigin } from "@/features/chat/team/ipc";

/**
 * A conversa vista igual pelo chat, pelas abas e pelo canvas (desenho da unificação, D2).
 *
 * A identidade é a ref que já existe: o `tab.id` de uma aba de agente (TUI, num PTY) ou
 * `thread:<id>` de uma conversa por protocolo. Não há UUID novo: trocar a ref quebraria as cordas
 * do canvas, `peer_messages`, o escopo da CLI e a autorização do Jev.
 *
 * Todo agente novo nasce COM TERMINAL (`pty`); `protocol` existe só para o que já nasceu por
 * protocolo.
 */
export type ConversationKind = "pty" | "protocol";

export interface UnifiedConversation {
  /** `tab.id` ou `thread:<id>`. */
  ref: string;
  kind: ConversationKind;
  agentId: string;
  cwd: string;
  title: string;
  /** O time do chat (`chat_team`) de que faz parte, como integrante ou orquestrador. */
  teamId?: string;
  /** O papel no time ou no canvas. Vazio para quem não tem. */
  role?: string;
  /** Onde mora a coroa/o nó: a chave do canvas (pasta, `#c:`, `#m:` ou `#cmp:`), quando se sabe. */
  boardKey?: string;
  /** A missão a que pertence (pelo time espelhado ou pelo canvas `#m:`). */
  missionId?: string;
  /** De onde o time nasceu. Só existe com `teamId`. */
  origin?: TeamOrigin;
  /** É o orquestrador do time. */
  lead: boolean;
  /** Marcado como subagente: só executa o que o orquestrador envia. */
  subagent: boolean;
  /** Sem PTY ainda: o agente está subindo (só `pty`). */
  starting: boolean;
  /** Quando abriu (aba) ou foi mexida por último (protocolo), em segundos; ordena a lista. */
  openedAt: number;
}
