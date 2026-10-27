/**
 * Quando o Vigia supervisiona uma CONVERSA de projeto (sem missão). Uma conversa não tem status nem
 * "Finalizar": antes bastava um orquestrador com uma corda até outro terminal aberto e o time era
 * vigiado para sempre, mesmo depois de o usuário passar a outra conversa. Ele seguia cobrando ociosos
 * e mandando "Decisão pendente" do projeto anterior. Tudo aqui é puro; quem põe o relógio é o Vigia.
 */

/** Conversa sem tarefa nova, sem mensagem entre agentes e sem saída nos terminais por isto = dormente. */
export const CONVERSATION_DORMANT_MS = 20 * 60_000;

/** As mensagens entre agentes guardadas (`ags.vigia.peers.v1`) somem depois disto. */
export const PEERS_KEEP_MS = 7 * 24 * 60 * 60_000;

export interface ConversationCheck {
  now: number;
  /** Estado da conversa no banco: só a ativa do projeto tem os terminais em uso. `null` = desconhecida. */
  state: "active" | "saved" | null;
  /** Quando cada integrante ligado por corda recebeu a última tarefa do Orquestrador. */
  taskTimes: readonly number[];
  /** Saída nos terminais e mensagens entre agentes do time (lead incluído). */
  activity: readonly (number | undefined)[];
}

/**
 * A conversa merece o Vigia agora? Pura.
 * - conversa guardada (o usuário abriu outra): não;
 * - corda sem tarefa: não é um time, é um terminal ao lado; só depois da 1ª delegação do Orquestrador;
 * - dormente (nada há `CONVERSATION_DORMANT_MS`): não, até a próxima tarefa.
 */
export function conversationWatchable({ now, state, taskTimes, activity }: ConversationCheck): boolean {
  if (state === "saved") return false;
  if (taskTimes.length === 0) return false;
  const latest = Math.max(...taskTimes, ...activity.filter((at): at is number => at !== undefined));
  return now - latest < CONVERSATION_DORMANT_MS;
}

/**
 * O aviso "Decisão pendente" ao usuário pode sair? Pura.
 * Numa conversa o usuário é o interlocutor direto do Orquestrador: esperar a resposta dele é o normal,
 * fica só a linha no chat. Numa missão, no máximo um aviso por rodada de tarefas (`round` = a última
 * tarefa delegada; antes repetia a cada 4 min enquanto a aba estivesse parada).
 */
export function userDecisionAllowed(kind: "mission" | "conversation", lastRound: number | undefined, round: number | undefined): boolean {
  if (kind === "conversation") return false;
  return lastRound === undefined || (round ?? 0) !== lastRound;
}

/** Só as entradas mais novas que `cutoff`, com valor finito. Pura. */
export function freshEntries(raw: Record<string, number> | undefined, cutoff: number): Map<string, number> {
  return new Map(Object.entries(raw ?? {}).filter(([, at]) => Number.isFinite(at) && at >= cutoff));
}
