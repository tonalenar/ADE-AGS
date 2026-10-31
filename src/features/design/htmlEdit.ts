/**
 * Edições do HTML de uma prancheta feitas pela tela: trocar o conteúdo de um elemento (texto editado
 * no lugar) e apagar um elemento. O seletor é o que o script do iframe calcula, relativo ao `<body>`
 * (o HTML do agente vai inteiro dentro do body do srcdoc). Usa `DOMParser`, que NÃO executa scripts.
 */
export type EditResult = { ok: true; html: string } | { ok: false; reason: "parse" | "missing" };

const isDocument = (html: string) => /<html[\s>]|<body[\s>]|<!doctype/i.test(html);

function parse(html: string): Document | null {
  if (typeof DOMParser === "undefined") return null;
  try {
    return new DOMParser().parseFromString(html, "text/html");
  } catch {
    return null;
  }
}

/** Serializa no mesmo formato da entrada: documento inteiro se era documento; senão head + body soltos. */
function serialize(doc: Document, original: string): string {
  if (isDocument(original)) {
    const doctype = /<!doctype/i.test(original) ? "<!doctype html>\n" : "";
    return doctype + doc.documentElement.outerHTML;
  }
  // Num fragmento, o parser leva `<style>`/`<link>` iniciais para o head: eles voltam na frente.
  return doc.head.innerHTML + doc.body.innerHTML;
}

function find(doc: Document, selector: string): Element | null {
  try {
    return doc.body.querySelector(`:scope > ${selector}`) ?? doc.body.querySelector(selector);
  } catch {
    return null;
  }
}

/** Troca o conteúdo (innerHTML) do elemento pelo que a pessoa editou. */
export function replaceInner(html: string, selector: string, inner: string): EditResult {
  const doc = parse(html);
  if (!doc) return { ok: false, reason: "parse" };
  const el = find(doc, selector);
  if (!el) return { ok: false, reason: "missing" };
  el.innerHTML = inner;
  // O que voltou do iframe pode trazer o contenteditable ou o contorno de destaque: limpa.
  el.removeAttribute("contenteditable");
  for (const n of el.querySelectorAll("[contenteditable]")) n.removeAttribute("contenteditable");
  return { ok: true, html: serialize(doc, html) };
}

/** Apaga o elemento. */
export function removeElement(html: string, selector: string): EditResult {
  const doc = parse(html);
  if (!doc) return { ok: false, reason: "parse" };
  const el = find(doc, selector);
  if (!el) return { ok: false, reason: "missing" };
  el.remove();
  return { ok: true, html: serialize(doc, html) };
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** O arquivo `.html` exportado: o documento como está, ou o fragmento embrulhado num documento. */
export function exportDocument(html: string, title: string): string {
  if (isDocument(html)) return /<!doctype/i.test(html) ? html : `<!doctype html>\n${html}`;
  return `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="margin:0">${html}</body></html>\n`;
}

/** Um nome de arquivo seguro a partir do título da prancheta. */
export function exportFileName(title: string, ext: string): string {
  const base = title.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9 _-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 80);
  return `${base || "prancheta"}.${ext}`;
}

/** O erro do backend quando a prancheta mudou desde que a pessoa começou a editar. */
export const isVersionConflict = (e: unknown) => /artboard changed|reload before editing/i.test(String(e));
