/**
 * El teclado de la lista del historial (↑/↓ mueven la marca, Enter retoma la marcada) escucha
 * en el contenedor, así que también le llegan las teclas de los controles de adentro (Exportar,
 * Apagar, el encabezado de carpeta). Esos controles tienen que actuar por su cuenta: Enter en
 * "Apagar" no puede retomar otra sesión.
 */

/** Lo mínimo de un elemento del DOM que se mira (los tests pasan objetos sueltos). */
export interface KeyTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?(name: string): string | null;
  parentElement?: KeyTargetLike | null;
}

const INTERACTIVE_TAGS = new Set(["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT", "SUMMARY"]);
const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const INTERACTIVE_ROLES = new Set(["button", "link", "menuitem", "checkbox", "switch", "tab", "option"]);

function isInteractive(el: KeyTargetLike): boolean {
  if (el.isContentEditable) return true;
  if (INTERACTIVE_TAGS.has((el.tagName ?? "").toUpperCase())) return true;
  return INTERACTIVE_ROLES.has(el.getAttribute?.("role") ?? "");
}

function isEditable(el: KeyTargetLike): boolean {
  return !!el.isContentEditable || EDITABLE_TAGS.has((el.tagName ?? "").toUpperCase());
}

/** Sube del destino hasta el contenedor (sin incluirlo) buscando un control que cumpla `test`. */
function insideControl(target: KeyTargetLike | null, container: KeyTargetLike | null, test: (el: KeyTargetLike) => boolean): boolean {
  for (let el = target; el && el !== container; el = el.parentElement ?? null) {
    if (test(el)) return true;
  }
  return false;
}

/**
 * Si la tecla es de la lista o del control que la recibió. Enter es de la lista solo si no vino
 * de un control interactivo de adentro; las flechas, solo si no vienen de un campo editable (en un
 * botón no hacen nada propio, así que siguen moviendo la marca).
 */
export function listHandlesKey(key: string, target: KeyTargetLike | null, container: KeyTargetLike | null): boolean {
  if (key === "Enter") return !insideControl(target, container, isInteractive);
  if (key === "ArrowDown" || key === "ArrowUp") return !insideControl(target, container, isEditable);
  return false;
}
