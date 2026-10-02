/**
 * Arrastrar un archivo (o carpeta) del nodo de carpeta a un agente del canvas: se escribe su
 * ruta en la terminal del agente, como al soltar un archivo en una terminal.
 *
 * Con el puntero y no con el arrastre HTML5: la ventana de Tauri en Windows se queda con los
 * eventos de arrastre para soltar archivos del sistema, y las terminales vivas se dibujan
 * encima de los nodos, así que el destino se busca por la geometría de los nodos de agente
 * y no por el elemento bajo el puntero.
 */

/** Cuánto hay que moverse antes de que un clic pase a ser un arrastre. */
export const DRAG_THRESHOLD = 5;

/**
 * La ruta como se escribe en una línea de comandos: entre comillas si lleva espacios u otros
 * caracteres que un shell separaría, y con un espacio al final para seguir escribiendo.
 */
export function pathForTerminal(path: string): string {
  const needsQuotes = /[\s"'`$&|;<>()*?[\]{}!#~^]/.test(path);
  const quoted = needsQuotes ? `"${path.replace(/(["`$])/g, "\\$1")}"` : path;
  return `${quoted} `;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** El id del rectángulo (el más chico, si hay varios apilados) que contiene al punto. */
export function hitTest(rects: { id: string; rect: Rect }[], x: number, y: number): string | null {
  const area = (r: Rect) => (r.right - r.left) * (r.bottom - r.top);
  const hits = rects.filter(({ rect: r }) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  hits.sort((a, b) => area(a.rect) - area(b.rect));
  return hits[0]?.id ?? null;
}

/** Los nodos de agente que se ven ahora, con su caja en pantalla. */
function agentRects(): { id: string; el: HTMLElement; rect: Rect }[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".react-flow__node-agent")).map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.dataset.id ?? "", el, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } };
  }).filter((n) => n.id);
}

let justDragged = false;

/** ¿El clic que sigue viene de soltar un arrastre? Se consume: vale una sola vez. */
export function consumeDrag(): boolean {
  const was = justDragged;
  justDragged = false;
  return was;
}

/**
 * Empieza a seguir al puntero desde `down`. Pasado el umbral muestra una etiqueta con
 * `label` pegada al puntero y resalta el agente de abajo; al soltar sobre un agente llama
 * a `onDrop` con el id de su tab. Si nunca pasa el umbral, no hace nada y el clic sigue
 * siendo un clic.
 */
export function beginFileDrag(down: PointerEvent | React.PointerEvent, label: string, onDrop: (tabId: string) => void): void {
  if (down.button !== 0) return;
  const startX = down.clientX;
  const startY = down.clientY;
  let ghost: HTMLDivElement | null = null;
  let frame: HTMLDivElement | null = null;
  let over = "";

  // El resaltado es un marco aparte sobre el nodo: el `style` de los nodos lo reescribe
  // React Flow, y la terminal viva se dibuja encima de ellos.
  const mark = (target: { id: string; rect: Rect } | null) => {
    if ((target?.id ?? "") === over) return;
    over = target?.id ?? "";
    if (!target) {
      frame?.remove();
      frame = null;
      return;
    }
    if (!frame) {
      frame = document.createElement("div");
      Object.assign(frame.style, {
        position: "fixed", zIndex: "9998", pointerEvents: "none", borderRadius: "8px",
        border: "2px solid #60a5fa", background: "rgba(96,165,250,0.12)",
      } satisfies Partial<CSSStyleDeclaration>);
      document.body.appendChild(frame);
    }
    const { left, top, right, bottom } = target.rect;
    Object.assign(frame.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
  };

  const move = (e: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
      ghost = document.createElement("div");
      ghost.textContent = label;
      Object.assign(ghost.style, {
        position: "fixed", zIndex: "9999", pointerEvents: "none", padding: "3px 8px", borderRadius: "6px",
        font: "12px system-ui, sans-serif", color: "#fff", background: "rgba(59,130,246,0.92)",
        boxShadow: "0 4px 14px rgba(0,0,0,0.35)", maxWidth: "260px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      } satisfies Partial<CSSStyleDeclaration>);
      document.body.appendChild(ghost);
      document.body.style.userSelect = "none";
    }
    ghost.style.left = `${e.clientX + 12}px`;
    ghost.style.top = `${e.clientY + 12}px`;
    const rects = agentRects();
    const id = hitTest(rects, e.clientX, e.clientY);
    mark(rects.find((r) => r.id === id) ?? null);
  };

  const finish = (e: PointerEvent, cancel: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancelled);
    const dragged = ghost !== null;
    ghost?.remove();
    mark(null);
    document.body.style.userSelect = "";
    if (!dragged) return;
    // El `click` que el navegador dispara tras soltar no debe abrir el archivo.
    justDragged = true;
    window.setTimeout(() => { justDragged = false; }, 0);
    if (cancel) return;
    const id = hitTest(agentRects(), e.clientX, e.clientY);
    if (id) onDrop(id);
  };
  const up = (e: PointerEvent) => finish(e, false);
  const cancelled = (e: PointerEvent) => finish(e, true);

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancelled);
}
