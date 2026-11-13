/**
 * Cliques na vista nativa do navegador não chegam ao DOM do app, então os menus e popovers abertos (⋯, zoom,
 * perfis…), que fecham com um `pointerdown` fora deles, ficavam abertos. Este aviso repete esse "clique fora" no
 * `body`, e todos eles fecham pelo caminho que já têm. Também vale quando a janela perde o foco.
 */
export function closeAppPopovers(doc: Document = document): void {
  const target = doc.body ?? doc.documentElement;
  if (!target) return;
  const Pointer = doc.defaultView?.PointerEvent ?? doc.defaultView?.MouseEvent ?? MouseEvent;
  target.dispatchEvent(new Pointer("pointerdown", { bubbles: true, composed: true }));
}
