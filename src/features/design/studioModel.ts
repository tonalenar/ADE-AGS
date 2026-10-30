/**
 * Ferramentas, atalhos e cores da tela de Design. Puro: o componente traduz o evento e aplica a ação.
 */
export type DrawTool = "pencil" | "pen";
export type ShapeTool = "rect" | "oval" | "line" | "arrow";
export type Tool = "select" | "hand" | "text" | "artboard" | "note" | "comment" | DrawTool | ShapeTool;
/** Os botões soltos da barra; desenho e formas entram em menus que lembram a última usada. */
export const TOOLS: Array<{ id: Tool; key: string }> = [
  { id: "select", key: "Esc" },
  { id: "hand", key: "H" },
  { id: "text", key: "T" },
  { id: "artboard", key: "A" },
  { id: "note", key: "N" },
  { id: "comment", key: "C" },
];
export const DRAW_TOOLS: Array<{ id: DrawTool; key: string }> = [{ id: "pencil", key: "P" }, { id: "pen", key: "⇧P" }];
export const SHAPE_TOOLS: Array<{ id: ShapeTool; key: string }> = [
  { id: "rect", key: "R" }, { id: "oval", key: "O" }, { id: "line", key: "L" }, { id: "arrow", key: "⇧L" },
];
export const isDrawTool = (t: Tool): t is DrawTool => t === "pencil" || t === "pen";
export const isShapeTool = (t: Tool): t is ShapeTool => t === "rect" || t === "oval" || t === "line" || t === "arrow";

export interface KeyLike { key: string; meta: boolean; ctrl: boolean; shift: boolean; alt: boolean; phase: "down" | "up" }

export type KeyAction =
  | { type: "tool"; tool: Tool }
  | { type: "zoomIn" } | { type: "zoomOut" } | { type: "fit" }
  | { type: "escape" } | { type: "delete" } | { type: "duplicate" } | { type: "selectAll" }
  | { type: "spaceDown" } | { type: "spaceUp" }
  | { type: "undo" } | { type: "redo" } | { type: "guides" } | { type: "panel" }
  | { type: "cycle"; dir: 1 | -1 };

const TOOL_KEYS: Record<string, Tool> = { h: "hand", a: "artboard", n: "note", c: "comment", t: "text", p: "pencil", r: "rect", o: "oval", l: "line" };
const SHIFT_TOOL_KEYS: Record<string, Tool> = { p: "pen", l: "arrow" };

/**
 * A ação de uma tecla. As letras de ferramenta não valem com ⌘, Ctrl ou Alt; o zoom é ⌘0 (enquadrar),
 * ⌘= / ⌘+ e ⌘− (Ctrl no Windows/Linux). `null` = a tecla não é da tela (segue adiante).
 */
export function keyAction(k: KeyLike): KeyAction | null {
  const mod = k.meta || k.ctrl;
  if (k.key === " ") return k.phase === "down" ? { type: "spaceDown" } : { type: "spaceUp" };
  if (k.phase !== "down") return null;
  if (mod && !k.alt) {
    if (k.key === "0") return { type: "fit" };
    if (k.key === "=" || k.key === "+") return { type: "zoomIn" };
    if (k.key === "-" || k.key === "_") return { type: "zoomOut" };
    if (k.key.toLowerCase() === "d") return { type: "duplicate" };
    if (k.key.toLowerCase() === "a") return { type: "selectAll" };
    if (k.key.toLowerCase() === "z") return k.shift ? { type: "redo" } : { type: "undo" };
    if (k.key === "\\") return { type: "panel" };
    return null;
  }
  if (k.key === "Escape") return { type: "escape" };
  if (k.alt || mod) return null;
  if (k.key === "Tab") return { type: "cycle", dir: k.shift ? -1 : 1 };
  if (k.key === "Backspace" || k.key === "Delete") return { type: "delete" };
  const key = k.key.toLowerCase();
  if (k.shift) {
    if (key === "g") return { type: "guides" };
    const tool = SHIFT_TOOL_KEYS[key];
    return tool ? { type: "tool", tool } : null;
  }
  const tool = TOOL_KEYS[key];
  return tool ? { type: "tool", tool } : null;
}

/** Clicar de novo na ferramenta ativa volta à Seleção. */
export const nextTool = (current: Tool, clicked: Tool): Tool => (current === clicked && clicked !== "select" ? "select" : clicked);

/** O campo de texto é dono das teclas (não roubar o que a pessoa digita). */
export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.closest?.(".xterm");
}

/** As cores das notas (sticky). `null` = a amarela padrão. Classes do Tailwind, sem hex. */
export const NOTE_COLORS = ["yellow", "gray", "red", "orange", "green", "teal", "blue", "purple", "pink"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];
const NOTE_BG: Record<NoteColor, string> = {
  yellow: "bg-amber-100", gray: "bg-gray-100", red: "bg-red-100", orange: "bg-orange-100", green: "bg-green-100",
  teal: "bg-teal-100", blue: "bg-sky-100", purple: "bg-purple-100", pink: "bg-pink-100",
};
export const noteBg = (color: string | null | undefined) => NOTE_BG[(NOTE_COLORS as readonly string[]).includes(color ?? "") ? (color as NoteColor) : "yellow"];

/** A nota cresce até 4/3 da largura; depois rola. */
export const noteMaxHeight = (w: number) => Math.round((w * 4) / 3);
export const NOTE_DEFAULT = { w: 240, h: 160 } as const;
export const BOARD_DEFAULT = { w: 1280, h: 800 } as const;

/** O símbolo do modificador para os atalhos exibidos. */
export const modSymbol = (platform: string) => (/mac|iphone|ipad/i.test(platform) ? "⌘" : "Ctrl+");

/** O "link" de uma prancheta/página: o comando que a abre (o app não tem URL externa). */
export function openCommand(designId: string, target: { artboardId?: string; pageId?: string } = {}): string {
  return `ags design open ${designId}${target.artboardId ? ` --artboard ${target.artboardId}` : ""}${target.pageId ? ` --page ${target.pageId}` : ""}`;
}

/** A próxima "Página N" / "Prancheta N" que não colide com os nomes que já existem. */
export function nextName(base: string, taken: string[]): string {
  const set = new Set(taken.map((s) => s.trim().toLowerCase()));
  for (let n = taken.length + 1; ; n += 1) {
    const name = `${base} ${n}`;
    if (!set.has(name.toLowerCase())) return name;
  }
}

/**
 * A próxima prancheta no Tab: na ordem de leitura (linhas de cima para baixo, depois da esquerda para a
 * direita), a partir da selecionada; sem seleção, a primeira (ou a última no Shift+Tab).
 */
export function cycleBoard(boards: Array<{ id: string; x: number; y: number }>, current: string | null, dir: 1 | -1): string | null {
  if (boards.length === 0) return null;
  const order = [...boards].sort((a, b) => a.y - b.y || a.x - b.x);
  const i = current ? order.findIndex((b) => b.id === current) : -1;
  if (i < 0) return (dir > 0 ? order[0] : order[order.length - 1]).id;
  return order[(i + dir + order.length) % order.length].id;
}

/** Ordem de leitura de uma prancheta e o total ("Prancheta i de n"). */
export function boardOrdinal(boards: Array<{ id: string; x: number; y: number }>, id: string): { i: number; n: number } {
  const order = [...boards].sort((a, b) => a.y - b.y || a.x - b.x);
  return { i: order.findIndex((b) => b.id === id) + 1, n: order.length };
}

/** As colunas das guias de layout: 12 colunas com margem e calha proporcionais à largura. */
export function layoutColumns(width: number, count = 12): Array<{ x: number; w: number }> {
  const margin = Math.round(Math.min(64, Math.max(8, width * 0.04)));
  const gutter = Math.round(Math.min(24, Math.max(4, width * 0.02)));
  const col = (width - margin * 2 - gutter * (count - 1)) / count;
  if (col <= 0) return [];
  return Array.from({ length: count }, (_, i) => ({ x: margin + i * (col + gutter), w: col }));
}
