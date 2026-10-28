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

/** Uma resposta curta de "recebi" ou de andamento não é entrega, mesmo mandada ao Orquestrador. */
const NOT_A_DELIVERY = /^(recebid[oa]|ok\b|entendid[oa]|certo\b|beleza|iniciando|come[cç]ando|comecei|aguardando|vou\b|j[aá] estou|em progresso|em andamento|parcial|progresso|status|ainda\b)/i;
/** Quanto o texto precisa ter para valer como relatório final quando vai ao Orquestrador (resultado, testes, arquivos…). */
export const REPORT_MIN_CHARS = 100;

/**
 * Só o relatório final encerra a tarefa; perguntas e progresso não encerram. Vale como final:
 * (a) a primeira linha com o marcador explícito (ENTREGUE, concluído, terminei…), para quem fala com qualquer um; ou
 * (b) um `tell` ao ORQUESTRADOR, sem pergunta, que não seja só "recebi"/andamento e tenha corpo de relatório
 *     (o briefing manda cada integrante mandar UMA mensagem final ao Orquestrador, e ela quase nunca usa o marcador).
 * Uma mensagem a outro integrante (ex.: "confirmado, obrigado" ao QA) nunca é entrega. Pura.
 */
export function isFinalReport(text: string | null | undefined, kind = "tell", name?: string, toLead = false): boolean {
  // `ags peer deliver`: a entrega estruturada é final por definição, sem adivinhar pelo texto.
  if (kind === "handoff") return true;
  if (kind !== "tell") return false;
  const firstLine = (text ?? "").trim().split(/\r?\n/, 1)[0];
  let plain = firstLine;
  if (name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    plain = plain.replace(new RegExp(`^${escaped}(?:\\s+v\\d+)?(?:\\s*[:—-]\\s*|\\s+)`, "i"), "");
  }
  // O prefixo com o nome ("Backend: em andamento…") sai antes de olhar se é só andamento.
  if (toLead && !firstLine.includes("?") && (text ?? "").trim().length >= REPORT_MIN_CHARS && !NOT_A_DELIVERY.test(plain.trim())) return true;
  return !firstLine.includes("?")
    && /^(entregue|entrega final|trabalho conclu[ií]do|encerrad[oa]|finalizad[oa]|conclu[ií]d[oa]|terminei)\b/i.test(plain);
}

/** Recebeu uma tarefa e entregou um relatório FINAL depois dela: parado à espera. */
export function memberFinished(taskAt: number | undefined, reportedAt: number | undefined): boolean {
  return taskAt !== undefined && reportedAt !== undefined && reportedAt >= taskAt;
}
