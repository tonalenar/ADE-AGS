/** A tela do Android só é pedida com a janela visível, o canvas à vista e o nó na tela. */
export function androidFrameShouldPoll(opts: { hidden: boolean; surfaceOpen: boolean; onScreen: boolean }): boolean {
  return !opts.hidden && opts.surfaceOpen && opts.onScreen;
}
