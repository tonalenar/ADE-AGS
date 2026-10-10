/**
 * Quando o Vigia pode escrever no terminal de um agente. O Vigia fala com o Orquestrador, mas o
 * Orquestrador não fala com ele: sem regra, cada ciclo colava outro aviso numa caixa de entrada
 * que já tinha o anterior (os "[Pasted text #3] [Pasted text #4]" empacados), e cutucava quem
 * já entregou e esperava com razão. Tudo aqui é puro.
 */

/** Uma cutucada sem resposta bloqueia as seguintes por isto. */
export const POKE_PENDING_MS = 10 * 60_000;

/**
 * Pode escrever agora? Não com o agente trabalhando (a TUI enfileira o texto e o Enter se perde),
 * e só uma por vez: a anterior precisa ter sido respondida (o agente mandou algo depois dela) ou
 * ter passado `POKE_PENDING_MS`.
 */
export function pokeAllowed(pokedAt: number | undefined, repliedAt: number | undefined, working: boolean, now: number): boolean {
  if (working) return false;
  if (pokedAt === undefined) return true;
  if (repliedAt !== undefined && repliedAt > pokedAt) return true;
  return now - pokedAt >= POKE_PENDING_MS;
}

/** Recebeu uma tarefa e já reportou depois dela: parado à espera, não travado. */
export function memberFinished(taskAt: number | undefined, reportedAt: number | undefined): boolean {
  return taskAt !== undefined && reportedAt !== undefined && reportedAt >= taskAt;
}
