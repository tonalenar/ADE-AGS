/**
 * O que a TELA mostra de uma "mensagem da pessoa" do fio. O modelo recebe tudo; a tela só a conversa.
 *
 * Entram como mensagem da pessoa coisas que não são dela:
 * - injeções do ADE, que começam com `[ADE AGS]` (resumo do time, "você é o orquestrador", "você entrou
 *   no time…"): somem da tela;
 * - o resumo do time colado na frente do que a pessoa digitou (`rosterNotice` + linha em branco +
 *   texto): some só o resumo;
 * - o prefixo do seletor "Só o orquestrador" (`LEAD_ONLY_PREFIX`): some, fica o texto da pessoa.
 *
 * `[Mensagem de X via ADE AGS]` NÃO é injeção: é o envelope de outro agente, tratado por
 * `peerEnvelope.ts` como balão do remetente. Puro.
 */

const INJECTION = /^\s*\[ADE AGS\]/;
const LEAD_ONLY = /^\s*\[Só o orquestrador\][^\n]*(?:\n|$)/;
/** Os fechos dos resumos do time que o composer cola na frente do texto da pessoa (`teamModel.rosterNotice`). */
const ROSTER_TAILS = ["Use `ags team list` para ver o time.", "ligar agentes no painel Time."];

/** O texto começa com uma injeção do ADE (`[ADE AGS] …`)? Não confunde com `[Mensagem de X via ADE AGS]`. */
export function isSystemInjection(text: string): boolean {
  return INJECTION.test(text);
}

/**
 * O que mostrar da mensagem: o texto limpo, ou `null` quando não há nada da pessoa (injeção pura).
 * Injeção seguida de linha em branco só vira texto da pessoa se for o resumo do time conhecido.
 */
export function displayUserText(text: string): string | null {
  let out = text;
  if (isSystemInjection(out)) {
    const cut = out.search(/\n\s*\n/);
    const head = cut < 0 ? out : out.slice(0, cut);
    if (cut < 0 || !ROSTER_TAILS.some((tail) => head.trimEnd().endsWith(tail))) return null;
    out = out.slice(cut).trim();
  }
  out = out.replace(LEAD_ONLY, "").trim();
  return out ? out : null;
}
