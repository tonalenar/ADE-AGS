/**
 * Ensina o agente a usar o navegador do canvas.
 *
 * O backend já deixa um agente criar e manejar navegadores (`ags portal …`), mas o agente não sabe
 * disso se ninguém contar: ele abriria o navegador do sistema, ou nenhum. Dois avisos:
 *
 * - `BROWSER_HINT`: uma linha que vai junto do que cada agente recebe ao nascer (briefings, texto
 *   inicial): para abrir um site, `ags portal create`;
 * - `portalConnectedNotice`: quando a pessoa liga uma corda entre o agente e um navegador, ele
 *   recebe o nome do navegador e como manejá-lo.
 */
import { isPortalId, type Board } from "./board";

/** A linha que ensina a abrir um navegador no canvas, já ligado ao agente que a lê. */
export const BROWSER_HINT =
  "NAVEGADOR: REUTILIZE o que você já tem — `ags portals` lista os seus; para outra página use `ags portal navigate \"<nome>\" <url>` no MESMO navegador (um por tarefa enche o canvas; o limite é 4). Só crie um novo se precisar de dois ao mesmo tempo: `ags portal create \"<nome>\" <url>` abre um navegador no canvas, já conectado a você (com um nome que já existe, reaproveita o que está lá); não abra o navegador do sistema. "
  + "Depois: `ags portal snapshot \"<nome>\"` (a página, com refs @e1…), `click`, `type`, `press`, `scroll`, `wait`, `screenshot`; ao terminar, feche o que criou com `ags portal close \"<nome>\"`. "
  + "Para PRINTS da página use `ags portal screenshot \"<nome>\"`: devolve o caminho de um PNG que você pode copiar para onde quiser. Não rode Playwright, Puppeteer ou Selenium com janela (headless: false): isso abre um navegador fora do canvas, que a pessoa não pediu. "
  + "Para um trajeto de vários cliques (login, formulário), `ags portal act \"<nome>\" \"<objetivo>\" --fill campo=valor` deixa o Jev navegar rápido (se estiver ligado; com o MCP do ADE AGS, a ferramenta `browser_act` faz o mesmo); diga no objetivo TODAS as escolhas (tamanho, item, seção) e prefira UM `act` com o trajeto inteiro (`--steps` até 15) a vários pequenos: cada chamada extra custa um turno seu; confira a página que ele devolve; em carrinho, envio de formulário ou filtro passe `--expect text:\"...\"` (ou `url:/...`, `count:N`, `absent:\"...\"`) e ele confere por código: FEITO (verificado) ou NÃO CONFERE. `ags --help` lista tudo.";

/** O aviso de que um navegador foi ligado a este agente, ou `null` se a corda não é entre um agente e um navegador. */
export function portalConnectedNotice(board: Board, a: string, b: string): { agent: string; text: string } | null {
  const [portalId, agent] = isPortalId(a) ? [a, b] : isPortalId(b) ? [b, a] : [null, null];
  if (!portalId || !agent || !(agent in board.nodes)) return null;
  const portal = board.portals[portalId];
  if (!portal || portal.kind === "android") return null;
  if (portal.kind === "ios") {
    return {
      agent,
      text: `[ADE AGS] O simulador iOS "${portal.name}" do canvas foi conectado a você. `
        + `Pilote com \`ags device shot "${portal.name}"\` (foto + tamanho em pontos), \`tap --x --y\`, \`swipe\`, \`type\`, \`key\`, \`button home\`, \`open <url>\` (Safari do aparelho) e \`launch <bundle>\`. `
        + `A pessoa conversa com você pelo painel do simulador: responda lá com \`ags device say "${portal.name}" "…"\`.`,
    };
  }
  const where = portal.url ? ` (${portal.url})` : "";
  return {
    agent,
    text: `[ADE AGS] O navegador "${portal.name}"${where} do canvas foi conectado a você. `
      + `Maneje-o com \`ags portal snapshot "${portal.name}"\` (a página, com refs @e1…), \`ags portal navigate "${portal.name}" <url>\`, `
      + "`click`, `type`, `press`, `scroll`, `wait` e `screenshot`. A pessoa vê tudo o que você faz nele; `ags portals` lista os seus navegadores.",
  };
}
