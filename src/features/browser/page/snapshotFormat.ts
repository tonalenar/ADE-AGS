/**
 * El texto que lee un agente para "ver" la página: un árbol de lo que se puede leer y
 * tocar, con un ref por elemento interactivo.
 *
 * No es el DOM: una página real tiene miles de `div` que no significan nada para quien la
 * usa. Es la forma de un árbol de accesibilidad —rol, nombre, estado—, que es además lo
 * que los modelos ya saben leer (es la forma de los snapshots de Playwright). Recorrer el
 * DOM vive en `runtime.ts`; acá solo el formato, puro y probado.
 */

export interface SnapshotNode {
  depth: number;
  role: string;
  name: string;
  /** Solo los que se pueden tocar. */
  ref?: string;
  /** `disabled`, `checked`, `expanded`, `focused`… */
  states: string[];
  value?: string;
  /** El destino de un link, sin el origen si es el de la página. */
  href?: string;
  /** Las opciones de una lista nativa (`<select>`): sin ellas no se sabe qué se puede elegir. */
  options?: string[];
}

export interface SnapshotMeta {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  scrollY: number;
  documentHeight: number;
  /** Quantos nós ficaram de fora, no total (fora da janela + além do limite). */
  omitted: number;
  /** Desses, quantos estão fora da janela da página (rolar traz) — só no modo do piloto. */
  outOfView?: number;
  /** E quantos passaram do limite de nós (o snapshot completo traz até um limite maior). */
  overLimit?: number;
  /** Quantos dos omitidos, de cada causa, são controles (teriam ref): é o que mais importa a quem vai tocar. */
  outOfViewControls?: number;
  overLimitControls?: number;
  /** O limite de nós listados neste snapshot. */
  limit?: number;
}

const quote = (s: string) => JSON.stringify(s);

export function formatNode(node: SnapshotNode): string {
  let line = `${"  ".repeat(node.depth)}- ${node.role}`;
  if (node.name) line += ` ${quote(node.name)}`;
  if (node.ref) line += ` [ref=${node.ref}]`;
  for (const state of node.states) line += ` [${state}]`;
  if (node.value !== undefined) line += ` value=${quote(node.value)}`;
  if (node.href) line += ` → ${node.href}`;
  if (node.options?.length) line += ` options=${JSON.stringify(node.options)}`;
  return line;
}

/**
 * A linha que conta o que ficou de fora. Separa o que está fora da janela (rolar traz) do que passou do limite (só o
 * snapshot completo traz) e diz quantos são controles: «… 25 nós fora da janela (role para ver; 7 são controles) · 30 nós
 * além do limite de 600 (peça o snapshot completo)». Sem o detalhe (quem monta a meta à mão), a contagem total.
 */
export function omittedLine(
  meta: Pick<SnapshotMeta, "omitted" | "outOfView" | "overLimit" | "outOfViewControls" | "overLimitControls" | "limit">,
): string {
  if (meta.outOfView === undefined && meta.overLimit === undefined) {
    return `… ${meta.omitted} nós omitidos (peça o snapshot completo ou role a página)`;
  }
  const controls = (n: number | undefined) => (n && n > 0 ? `; ${n} ${n === 1 ? "é controle" : "são controles"}` : "");
  const parts: string[] = [];
  if (meta.outOfView) parts.push(`${meta.outOfView} nós fora da janela (role para ver${controls(meta.outOfViewControls)})`);
  if (meta.overLimit) {
    parts.push(`${meta.overLimit} nós além do limite${meta.limit ? ` de ${meta.limit}` : ""} (peça o snapshot completo${controls(meta.overLimitControls)})`);
  }
  return `… ${parts.join(" · ")}`;
}

export function formatSnapshot(nodes: SnapshotNode[], meta: SnapshotMeta): string {
  const header = [
    `page: ${meta.title ? `${quote(meta.title)} ` : ""}${meta.url}`,
    `viewport: ${meta.viewport.width}×${meta.viewport.height} · scroll ${Math.round(meta.scrollY)}/${Math.round(meta.documentHeight)}`,
  ];
  const body = nodes.length ? nodes.map(formatNode) : ["(la página no tiene contenido visible)"];
  if (meta.omitted > 0) body.push(omittedLine(meta));
  return [...header, "", ...body].join("\n");
}

/**
 * Um elemento está longe da janela da página (meia tela acima, uma tela abaixo)? Só o piloto usa: numa página longa o
 * snapshot em ordem de página gasta os nós no menu e perde os resultados. Sem medidas (largura e altura 0) ou fixo/sticky
 * (um cabeçalho que acompanha a rolagem) nunca é "longe". Pura.
 */
export function farFromWindow(
  box: { top: number; bottom: number; width: number; height: number },
  viewHeight: number,
  position = "static",
): boolean {
  if (box.width === 0 && box.height === 0) return false;
  if (position === "fixed" || position === "sticky") return false;
  return box.bottom < -viewHeight * 0.5 || box.top > viewHeight * 2;
}

/** Espacios colapsados y recortado: los nombres son para leer, no para comparar. */
export function normalizeName(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Un link hacia la misma página se muestra como ruta: el origen del proxy es ruido. */
export function displayHref(href: string, pageOrigin: string): string {
  return href.startsWith(`${pageOrigin}/`) ? href.slice(pageOrigin.length) : href;
}

/**
 * `Control+Shift+a` → la tecla y sus modificadores. Acepta los nombres de Playwright
 * (`Meta`, `ControlOrMeta`) porque son los que un agente va a escribir.
 */
export function parseKeyCombo(combo: string): {
  key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean;
} {
  const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
  // `+` sola, o `Control++`: la última parte vacía era la tecla `+`.
  const key = combo.endsWith("++") || combo === "+" ? "+" : (parts.pop() ?? "");
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return {
    key,
    ctrlKey: mods.has("control") || mods.has("ctrl") || mods.has("controlormeta"),
    shiftKey: mods.has("shift"),
    altKey: mods.has("alt") || mods.has("option"),
    metaKey: mods.has("meta") || mods.has("cmd") || mods.has("command"),
  };
}

/**
 * Um nome para um elemento que não tem nenhum, tirado do `id` ou do `data-testid`: `nav-search-submit-button` →
 * "nav search submit button". Só serve de pista (o piloto distingue o ícone da lupa do ícone do carrinho): vale se tem
 * pelo menos duas palavras de letras, é curto e não parece um hash. `""` = sem pista. Pura.
 */
export function humanizeId(raw: string | null | undefined): string {
  if (!raw) return "";
  // Um pedaço só de números ("a-autoid-3-announce", "item-42-title") é id gerado, não um nome.
  if (raw.split(/[\s_.:\-/]+/).some((part) => /^\d+$/.test(part))) return "";
  const words = raw
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[\s_.:\-/]+/)
    .filter((w) => /^[A-Za-z]{2,}$/.test(w));
  const text = words.join(" ").toLowerCase();
  if (words.length < 2 || text.length > 40) return "";
  // "a autoid 3 announce", "x9f2k...": uma palavra sem vogal é lixo gerado, não um nome.
  if (words.some((w) => !/[aeiouy]/i.test(w))) return "";
  return text;
}

/**
 * Os pontos onde tentar um clique num elemento: o centro primeiro; se algo decorativo o cobre (a Amazon põe uma
 * camada sobre o título de um produto), os pontos perto das bordas. Pura.
 */
export function probePoints(rect: { left: number; top: number; width: number; height: number }): { x: number; y: number }[] {
  const { left, top, width, height } = rect;
  const cx = left + width / 2;
  const cy = top + height / 2;
  const inset = (size: number) => Math.min(6, Math.max(1, size / 4));
  const ix = inset(width);
  const iy = inset(height);
  return [
    { x: cx, y: cy },
    { x: left + ix, y: cy },
    { x: left + width - ix, y: cy },
    { x: cx, y: top + iy },
    { x: cx, y: top + height - iy },
    { x: left + ix, y: top + iy },
    { x: left + width - ix, y: top + height - iy },
  ];
}

/** Uma caixa na janela da página, em px CSS. */
export interface Box4 { left: number; top: number; right: number; bottom: number }

/** A distância de um ponto a uma caixa: 0 dentro dela. */
export function distanceToBox(box: Box4, x: number, y: number): number {
  const dx = Math.max(box.left - x, 0, x - box.right);
  const dy = Math.max(box.top - y, 0, y - box.bottom);
  return Math.hypot(dx, dy);
}

/**
 * Qual controle clicável fica com um toque que a foto apontou. Uma caixa de imagem de um alvo pequeno erra por
 * dezenas de pixels (um ícone de 48 px apontado 30 px ao lado, no vazio entre dois ícones), então o ponto vai para
 * o controle mais próximo: o menor que o contém, ou o mais perto dentro do `radius`. Se dois estão quase à mesma
 * distância (`margin`), não adivinha. Pura.
 */
export function snapToNearest(boxes: Box4[], x: number, y: number, radius = 40, margin = 6): { index: number } | { ambiguous: true } | null {
  const scored = boxes.map((box, index) => ({ index, d: distanceToBox(box, x, y), area: (box.right - box.left) * (box.bottom - box.top) }));
  const inside = scored.filter((c) => c.d === 0).sort((a, b) => a.area - b.area);
  if (inside.length > 0) return { index: inside[0].index };
  const near = scored.filter((c) => c.d <= radius).sort((a, b) => a.d - b.d);
  if (near.length === 0) return null;
  if (near.length > 1 && near[1].d - near[0].d < margin) return { ambiguous: true };
  return { index: near[0].index };
}

/** Cómo se parsea un `target`: un ref de snapshot, un texto visible, o un selector CSS. */
export type TargetSpec =
  | { kind: "ref"; ref: string }
  | { kind: "text"; text: string }
  | { kind: "css"; selector: string }
  /** Um ponto da janela da página, em px CSS: o que a reserva visual do piloto aponta numa foto. */
  | { kind: "point"; x: number; y: number; second?: boolean };

export function parseTarget(target: string): TargetSpec {
  const t = target.trim();
  // `e12` sale de un snapshot; `u3`, de algo que el usuario marcó en el navegador.
  // `@e63` também: é como a ajuda de `ags portal click` escreve um ref.
  const asRef = /^@?([eu]\d+)$/.exec(t);
  if (asRef) return { kind: "ref", ref: asRef[1] };
  // `@x,y#2`: o SEGUNDO controle sem nome perto do ponto (o primeiro já foi tocado e não era o certo: dois ícones lado a lado).
  const point = /^@(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)(#2)?$/.exec(t);
  if (point) return { kind: "point", x: Number(point[1]), y: Number(point[2]), ...(point[3] ? { second: true } : {}) };
  const text = /^text[=:](.+)$/s.exec(t);
  if (text) return { kind: "text", text: text[1].trim().replace(/^["'](.*)["']$/s, "$1") };
  return { kind: "css", selector: t };
}
