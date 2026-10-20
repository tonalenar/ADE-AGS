/**
 * O mouse num terminal ESCALADO (o canvas fora de 100 %: ver `canvas/geometry.ts`, `terminalRect`).
 *
 * A terminal do canvas mantém o tamanho real e é desenhada com `transform: scale(zoom)`, para não mudar linhas e
 * colunas a cada zoom. O xterm não conhece transformações: ele mede a distância do clique em pixels de TELA e a
 * divide pelo tamanho da célula SEM a escala. A 87 % de zoom a seleção "escorregava" umas linhas para cima, e o erro
 * crescia conforme o ponteiro descia. Aqui cada evento de mouse que cai numa terminal escalada (marcada com
 * `data-term-scale`) é reemitido com a coordenada desfeita da escala antes de o xterm vê-lo; o arrasto que começou
 * nela segue corrigido até soltar o botão, mesmo fora dela.
 */

const EVENTS = ["mousedown", "mousemove", "mouseup", "click", "dblclick", "contextmenu"] as const;

/** O ponto como o xterm precisa: a mesma origem do elemento, a distância dividida pela escala. Pura. */
export function unscaledPoint(client: { x: number; y: number }, origin: { left: number; top: number }, scale: number): { x: number; y: number } {
  if (!(scale > 0) || Math.abs(scale - 1) < 0.001) return client;
  return { x: origin.left + (client.x - origin.left) / scale, y: origin.top + (client.y - origin.top) / scale };
}

/** Liga a correção para a janela inteira (uma vez). Devolve o desligar. */
export function installScaledMouseFix(win: Window = window): () => void {
  const synthetic = new WeakSet<Event>();
  /** O arrasto que começou numa terminal escalada: segue com a mesma origem e escala até o botão subir. */
  let drag: { el: HTMLElement; scale: number } | null = null;

  const scaledHost = (target: EventTarget | null): { el: HTMLElement; scale: number } | null => {
    const el = target instanceof Element ? target.closest<HTMLElement>("[data-term-scale]") : null;
    const scale = el ? Number(el.dataset.termScale) : NaN;
    return el && scale > 0 && Math.abs(scale - 1) >= 0.001 ? { el, scale } : null;
  };

  const onMouse = (event: Event) => {
    if (!(event instanceof MouseEvent) || synthetic.has(event)) return;
    const host = drag ?? scaledHost(event.target);
    if (!host) return;
    if (event.type === "mousedown" && event.button === 0) drag = host;
    if (event.type === "mouseup") drag = null;
    // A origem é a tela do xterm (a mesma de onde ele mede), não o embrulho: o recuo entre os dois também é escalado.
    const origin = (host.el.querySelector(".xterm-screen") ?? host.el).getBoundingClientRect();
    const point = unscaledPoint({ x: event.clientX, y: event.clientY }, origin, host.scale);
    const copy = new MouseEvent(event.type, {
      bubbles: event.bubbles, cancelable: event.cancelable, composed: event.composed, view: event.view, detail: event.detail,
      clientX: point.x, clientY: point.y, screenX: event.screenX, screenY: event.screenY,
      button: event.button, buttons: event.buttons, relatedTarget: event.relatedTarget,
      ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey,
    });
    synthetic.add(copy);
    event.stopImmediatePropagation();
    (event.target ?? host.el).dispatchEvent(copy);
    // O que o xterm cancelou (seleção nativa, menu do navegador) vale para o evento de verdade.
    if (copy.defaultPrevented) event.preventDefault();
  };

  for (const type of EVENTS) win.addEventListener(type, onMouse, { capture: true });
  return () => {
    for (const type of EVENTS) win.removeEventListener(type, onMouse, { capture: true });
  };
}
