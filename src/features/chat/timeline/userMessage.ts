/**
 * O que a TELA mostra de uma "mensagem da pessoa" do fio. O modelo recebe tudo; a tela só a conversa.
 *
 * Entram como mensagem da pessoa coisas que não são dela:
 * - injeções do ADE, que começam com `[ADE AGS]` (resumo do time, "você é o orquestrador", "você entrou
 *   no time…"): somem da tela;
 * - o resumo da conversa anterior, que vai na frente da primeira mensagem depois de trocar de agente: some só ele;
 * - o resumo do time colado na frente do que a pessoa digitou (`rosterNotice` + linha em branco +
 *   texto): some só o resumo;
 * - o prefixo do seletor "Só o orquestrador" (`LEAD_ONLY_PREFIX`): some, fica o texto da pessoa;
 * - o aviso que o backend põe na frente do envio quando o turno anterior caiu com ferramenta sem resultado
 *   (`[Aviso do ADE AGS, não da pessoa] TOOL_OUTCOME_UNKNOWN…`, `conversa/resume.rs`): some (a timeline já o mostra
 *   como aviso próprio). Sem isso a fala aparecia com o aviso colado e o balão otimista não achava o eco: ficava
 *   «Na fila» no fim da timeline até sumir.
 * - o recorte da conversa de origem que a pergunta lateral leva ao agente (`<contexto-da-conversa-de-origem>`, com o
 *   preâmbulo e o rótulo «Pergunta lateral do usuário:»): somem; fica só a pergunta da pessoa.
 *
 * `[Mensagem de X via ADE AGS]` NÃO é injeção: é o envelope de outro agente, tratado por
 * `peerEnvelope.ts` como balão do remetente. Puro.
 */

/** A última linha do resumo que a conversa leva ao trocar de agente (`conversa/handoff.rs::END_MARK`). */
const HANDOFF_END = "[fim do contexto da conversa anterior]";
const INJECTION = /^\s*\[ADE AGS\]/;
/** O aviso do backend antes do texto (`resume::unknown_outcome_note`): um parágrafo, até a primeira linha em branco. */
const BACKEND_NOTE = /^\s*\[Aviso do ADE AGS, não da pessoa\][\s\S]*?(?:\n\s*\n|$)/;
const LEAD_ONLY = /^\s*\[Só o orquestrador\][^\n]*(?:\n|$)/;
/** Os fechos dos resumos do time que o composer cola na frente do texto da pessoa (`teamModel.rosterNotice`). */
const ROSTER_TAILS = ["Use `ags team list` para ver o time.", "ligar agentes no painel Time.", HANDOFF_END];
/** A marca em volta do recorte da conversa de origem que a pergunta lateral manda (`sideChatModel.sideChatContext`). */
export const SIDE_CHAT_CONTEXT_TAG = "contexto-da-conversa-de-origem";
/** O rótulo da pergunta da pessoa, depois do recorte, na pergunta lateral. */
export const SIDE_CHAT_QUESTION_LABEL = "Pergunta lateral do usuário: ";
/** Recorte e instruções que a pergunta lateral leva ao agente antes da pergunta: a tela mostra só a pergunta. */
const SIDE_CHAT_PREFACE = new RegExp(`^\\s*Esta é uma conversa lateral independente[\\s\\S]*?</${SIDE_CHAT_CONTEXT_TAG}>\\n\\n(?:${SIDE_CHAT_QUESTION_LABEL})?`);

/** O texto começa com uma injeção do ADE (`[ADE AGS] …`)? Não confunde com `[Mensagem de X via ADE AGS]`. */
export function isSystemInjection(text: string): boolean {
  return INJECTION.test(text);
}

/**
 * O que mostrar da mensagem: o texto limpo, ou `null` quando não há nada da pessoa (injeção pura).
 * Injeção seguida de linha em branco só vira texto da pessoa se for o resumo do time conhecido.
 */
export function displayUserText(text: string): string | null {
  let out = text.replace(BACKEND_NOTE, "").replace(SIDE_CHAT_PREFACE, "");
  if (isSystemInjection(out)) {
    const cut = out.search(/\n\s*\n/);
    const head = cut < 0 ? out : out.slice(0, cut);
    if (cut < 0 || !ROSTER_TAILS.some((tail) => head.trimEnd().endsWith(tail))) return null;
    out = out.slice(cut).trim();
  }
  out = out.replace(LEAD_ONLY, "").trim();
  return out ? out : null;
}
