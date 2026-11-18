/** O srcDoc só muda ao ligar a prancheta ou trocar o id; o HTML novo vai por postMessage. */
export function iframeSrcIdentity(boardId: string, live: boolean): string {
  return live ? `live:${boardId}` : `off:${boardId}`;
}
