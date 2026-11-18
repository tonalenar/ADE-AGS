/**
 * Lo que comparten el editor de archivos y el de diffs: tema, idioma y tipografía.
 *
 * El editor se viste con los colores de la app y no con los de un tema de CodeMirror: al
 * lado de la terminal, un fondo gris azulado de otro programa se lee como una ventana
 * incrustada. Del tema oscuro de CodeMirror solo se toma el resaltado de sintaxis.
 */
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { defaultHighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";

import { baseName } from "@/features/tabs/viewTabs";
import { TERMINAL_FONT } from "@/features/terminal/theme";

/** La misma familia que la terminal: el mismo código no puede verse con dos letras. */
const FONT = TERMINAL_FONT;

const base = EditorView.theme({
  // O mesmo tamanho do código no chat e nos diffs: segue a preferência de Tipografia.
  "&": { height: "100%", fontSize: "var(--text-chat-code)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: FONT, lineHeight: "1.6" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 16px" },
});

const dark = [
  EditorView.theme(
    {
      "&": { color: "var(--color-gray-100)" },
      ".cm-gutters": { color: "color-mix(in oklab, var(--color-gray-100) 22%, transparent)" },
      ".cm-activeLine": { backgroundColor: "color-mix(in oklab, white 3.5%, transparent)" },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: "color-mix(in oklab, var(--color-gray-100) 65%, transparent)" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent-300)" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: "color-mix(in oklab, var(--color-accent-300) 26%, transparent)" },
      ".cm-searchMatch": { backgroundColor: "color-mix(in oklab, var(--color-accent-400) 30%, transparent)" },
      ".cm-panels": { backgroundColor: "var(--color-gray-950)", color: "var(--color-gray-100)" },
      ".cm-panels input, .cm-panels button": { color: "inherit" },
      ".cm-tooltip": { backgroundColor: "var(--color-gray-900)", border: "1px solid color-mix(in oklab, white 12%, transparent)" },
      ".cm-foldPlaceholder": { backgroundColor: "color-mix(in oklab, white 8%, transparent)", border: "none", color: "var(--color-gray-400)" },
    },
    { dark: true }
  ),
  syntaxHighlighting(oneDarkHighlightStyle),
];

const light = [
  EditorView.theme(
    {
      ".cm-gutters": { color: "var(--color-gray-400)" },
      ".cm-activeLine": { backgroundColor: "color-mix(in oklab, black 3%, transparent)" },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--color-gray-700)" },
      ".cm-panels": { backgroundColor: "var(--color-gray-100)" },
    },
    { dark: false }
  ),
  // Explícito y no confiando en `basicSetup`: el diff no lo usa, y sin esto el tema claro
  // quedaba sin colores de sintaxis ahí.
  syntaxHighlighting(defaultHighlightStyle),
];

export function editorTheme(isDark: boolean): Extension {
  return [base, isDark ? dark : light];
}

/**
 * A quebra de linha do editor de arquivos: a mesma preferência de código (Aparência → Texto) que já quebra
 * os blocos do chat e os diffs. Desligada, a extensão nem entra e o editor rola na horizontal. Pura.
 */
export function wrapLines(on: boolean): Extension {
  return on ? EditorView.lineWrapping : [];
}

/** El soporte de lenguaje para un archivo. Se carga bajo demanda: son decenas de
 *  gramáticas y no tiene sentido meterlas todas en el arranque de la app. */
export async function languageFor(path: string): Promise<Extension> {
  const description = LanguageDescription.matchFilename(languages, baseName(path));
  return description ? description.load() : [];
}
