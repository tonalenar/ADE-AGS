/** O código de tecla virtual do Windows (`windowsVirtualKeyCode` do CDP) de uma tecla pelo nome do DOM. 0 = sem código
 *  (o CDP ainda entrega a tecla pelo `key`/`text`). */
const NAMED: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27, " ": 32, PageUp: 33, PageDown: 34, End: 35,
  Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};

export function virtualKeyCode(key: string): number {
  if (key in NAMED) return NAMED[key];
  if (/^[a-z]$/i.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^\d$/.test(key)) return key.charCodeAt(0);
  return 0;
}
