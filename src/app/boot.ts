/**
 * O que a home precisa antes de pintar, e o que não precisa.
 *
 * O catálogo de TUIs e o modo de composição seguem na frente: sem o catálogo uma
 * tab restaurada nasceria com o comando pelado, e sem a composição a terminal
 * tentaria WebGL numa janela que não tem. A fonte não entra. Ela segue em
 * `fontsReady` e só a primeira medição do xterm a espera.
 */
export function whenHomeCanPaint(deps: {
  loadAgentRegistry: () => Promise<unknown>;
  applyRendering: () => Promise<unknown>;
  fontsReady: Promise<unknown>;
}): Promise<void> {
  void deps.fontsReady;
  return Promise.all([deps.loadAgentRegistry(), deps.applyRendering()]).then(() => undefined);
}
