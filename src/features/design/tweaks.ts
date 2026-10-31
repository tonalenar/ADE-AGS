/**
 * Tweaks: as props declaradas no `data-props` de uma prancheta `.dc.html`
 * (`<script type="text/x-dc" data-dc-script data-props='{…}'>`). Cada prop vira um controle; "Salvar
 * como padrão" grava os valores de volta no atributo. Puro (só string e JSON).
 */
export type TweakEditor = "text" | "color" | "int" | "float" | "range" | "boolean" | "enum";
export interface Tweak {
  name: string;
  editor: TweakEditor;
  value: string | number | boolean;
  section: string | null;
  options: string[];
  min: number | null;
  max: number | null;
  step: number | null;
}

const ATTR = /data-props\s*=\s*(['"])([\s\S]*?)\1/i;
const EDITORS = new Set<TweakEditor>(["text", "color", "int", "float", "range", "boolean", "enum"]);

function unescapeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** O JSON cru do primeiro `data-props` (ou `null`). */
export function rawProps(html: string): Record<string, unknown> | null {
  const m = ATTR.exec(html);
  if (!m) return null;
  try {
    const v = JSON.parse(unescapeAttr(m[2]));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function inferEditor(v: unknown): TweakEditor | null {
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return /^#[0-9a-f]{3,8}$|^(rgb|hsl|oklch)\(/i.test(v) ? "color" : "text";
  return null;
}

/** As props com editor, na ordem do JSON. `$preview` e as sem editor (`null`) ficam de fora. */
export function readTweaks(html: string): Tweak[] {
  const props = rawProps(html);
  if (!props) return [];
  const out: Tweak[] = [];
  for (const [name, spec] of Object.entries(props)) {
    if (name.startsWith("$")) continue;
    if (spec && typeof spec === "object" && !Array.isArray(spec)) {
      const s = spec as Record<string, unknown>;
      const editor = typeof s.editor === "string" && EDITORS.has(s.editor as TweakEditor) ? (s.editor as TweakEditor) : inferEditor(s.default ?? s.value);
      if (!editor) continue;
      const value = (s.value ?? s.default) as Tweak["value"];
      const options = Array.isArray(s.options) ? s.options.filter((o): o is string => typeof o === "string").slice(0, 50) : [];
      out.push({ name, editor, value: value ?? (editor === "boolean" ? false : editor === "text" || editor === "color" || editor === "enum" ? "" : 0), section: typeof s.section === "string" ? s.section : null, options, min: num(s.min), max: num(s.max), step: num(s.step) });
    } else {
      const editor = inferEditor(spec);
      if (editor) out.push({ name, editor, value: spec as Tweak["value"], section: null, options: [], min: null, max: null, step: null });
    }
  }
  return out;
}

/** Grava os valores como padrão: `default` nas props com objeto, o valor nas primitivas. */
export function writeTweaks(html: string, values: Record<string, Tweak["value"]>): string {
  const m = ATTR.exec(html);
  const props = rawProps(html);
  if (!m || !props) return html;
  const next: Record<string, unknown> = { ...props };
  for (const [name, value] of Object.entries(values)) {
    if (!(name in next)) continue;
    const spec = next[name];
    next[name] = spec && typeof spec === "object" && !Array.isArray(spec) ? { ...(spec as object), default: value } : value;
  }
  // Aspas simples no atributo (como o formato), com as simples do JSON escapadas.
  const json = JSON.stringify(next).replace(/&/g, "&amp;").replace(/'/g, "&#39;");
  return html.slice(0, m.index) + `data-props='${json}'` + html.slice(m.index + m[0].length);
}

/** Agrupa por `section`, mantendo a ordem de aparição. */
export function groupTweaks(tweaks: Tweak[]): Array<{ section: string | null; items: Tweak[] }> {
  const groups: Array<{ section: string | null; items: Tweak[] }> = [];
  for (const t of tweaks) {
    const g = groups.find((x) => x.section === t.section);
    if (g) g.items.push(t);
    else groups.push({ section: t.section, items: [t] });
  }
  return groups;
}
