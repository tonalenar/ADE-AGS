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
  "NAVEGADOR: para abrir um site, o app que você está construindo ou qualquer URL, use `ags portal create \"<nome>\" <url>` — abre um navegador no canvas, já conectado a você (não abra o navegador do sistema). "
  + "Depois: `ags portal snapshot \"<nome>\"` (a página, com refs @e1…), `click`, `type`, `press`, `scroll`, `wait`, `screenshot`. "
  + "Para um trajeto de vários cliques (login, formulário), `ags portal act \"<nome>\" \"<objetivo>\" --fill campo=valor` deixa o Jev navegar rápido (se estiver ligado; com o MCP do ADE AGS, a ferramenta `browser_act` faz o mesmo); diga no objetivo TODAS as escolhas (tamanho, item, seção) e prefira UM `act` com o trajeto inteiro (`--steps` até 15) a vários pequenos: cada chamada extra custa um turno seu; confira a página que ele devolve. `ags --help` lista tudo.";

/** O aviso de que um navegador foi ligado a este agente, ou `null` se a corda não é entre um agente e um navegador. */
export function portalConnectedNotice(board: Board, a: string, b: string): { agent: string; text: string } | null {
  const [portalId, agent] = isPortalId(a) ? [a, b] : isPortalId(b) ? [b, a] : [null, null];
  if (!portalId || !agent || !(agent in board.nodes)) return null;
  const portal = board.portals[portalId];
  if (!portal || portal.kind === "android") return null;
  const where = portal.url ? ` (${portal.url})` : "";
  return {
    agent,
    text: `[ADE AGS] O navegador "${portal.name}"${where} do canvas foi conectado a você. `
      + `Maneje-o com \`ags portal snapshot "${portal.name}"\` (a página, com refs @e1…), \`ags portal navigate "${portal.name}" <url>\`, `
      + "`click`, `type`, `press`, `scroll`, `wait` e `screenshot`. A pessoa vê tudo o que você faz nele; `ags portals` lista os seus navegadores.",
  };
}
