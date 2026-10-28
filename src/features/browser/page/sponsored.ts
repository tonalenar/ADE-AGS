/**
 * A marca de patrocinado (achado O2 do plano v2): o que está dentro de um bloco de anúncio ganha o estado `[patrocinado]`
 * no snapshot, para quem escolhe um resultado (o piloto, um agente) poder pular o anúncio e ficar com o orgânico.
 *
 * Um bloco de anúncio se reconhece de quatro jeitos, do mais explícito ao mais frágil:
 *  1. `data-component-type="sp-sponsored-result"` (Amazon) ou qualquer `data-component-type`/`data-testid`/`data-test`/
 *     `data-qa` que diga «sponsored»/«patrocin…»; `data-sponsored`/`data-ad`.
 *  2. `aria-label` que COMEÇA com a palavra («Patrocinado», «Sponsored», «Anúncio», «Ad»).
 *  3. Uma classe CSS que diz (`s-sponsored-label`, `ui-search-item__ad-label`, `adsbygoogle`).
 *  4. Um texto curto e sozinho dizendo «Patrocinado»/«Sponsored»/«Anúncio»/«Ad» (opcionalmente «· marca»): o bloco é o
 *     menor ancestral que tem mais do que esse rótulo (o cartão do resultado).
 *
 * Não se marca uma página inteira por engano: `body`, `main` e os pontos de referência de página nunca são um bloco, e
 * um bloco achado só pelo rótulo de texto (o mais frágil) não pode ser grande demais.
 */

/** O que diz «isto é um anúncio». Sem `\b` depois do `ad`: «Adicionar» não é um anúncio. */
const WORD = "(?:patrocinad[oa]s?|sponsored|sponsorizado|promocionado|an[uú]ncio|publicidade|advertisement|ads?)";
const LABEL_TEXT = new RegExp(`^${WORD}(?:\\s*[·•:|\\-–—]\\s*\\S.{0,24})?$`, "i");
const LABEL_ARIA = new RegExp(`^\\s*${WORD}(?![\\p{L}\\p{N}])`, "iu");
const SPONSOR_WORD = /sponsor|patrocin/i;

const SELECTOR = [
  "[data-component-type]", "[data-sponsored]", "[data-ad]", "[data-testid]", "[data-test]", "[data-qa]", "[aria-label]",
  '[class*="sponsor" i]', '[class*="patrocin" i]', '[class*="advert" i]', '[class*="adsbygoogle" i]', '[class~="ad"]',
  '[class~="ads"]', '[class*="ad-label" i]', '[class*="ad-slot" i]', '[class*="ad-banner" i]', '[class*="promoted" i]',
].join(",");

/** Elementos que organizam a página e nunca são «o anúncio». */
const NEVER = new Set(["BODY", "HTML", "MAIN", "NAV", "HEADER", "FOOTER", "ASIDE", "FORM"]);
const MAX_LABELLED_BLOCK_CHARS = 3000;
const MAX_LABEL_CHARS = 36;

function sayssSponsored(el: Element): boolean {
  const type = el.getAttribute("data-component-type");
  if (type && SPONSOR_WORD.test(type)) return true;
  for (const name of ["data-sponsored", "data-ad"]) {
    const v = el.getAttribute(name);
    if (v !== null && v !== "false" && v !== "0") return true;
  }
  for (const name of ["data-testid", "data-test", "data-qa"]) {
    const v = el.getAttribute(name);
    if (v && SPONSOR_WORD.test(v)) return true;
  }
  const aria = el.getAttribute("aria-label");
  if (aria && LABEL_ARIA.test(aria)) return true;
  // O seletor já filtrou por classe; aqui só chegam as que o CSS achou.
  const klass = el.getAttribute("class");
  return !!klass && (/sponsor|patrocin|advert|adsbygoogle|ad-label|ad-slot|ad-banner|promoted/i.test(klass) || /(^|\s)ads?(\s|$)/.test(klass));
}

/** O cartão do resultado a que um rótulo «Patrocinado» pertence: sobe enquanto o ancestral não tem nada além do rótulo. */
function blockOfLabel(labelParent: Element, label: string): Element | null {
  let block: Element | null = labelParent;
  for (let up = 0; block && up < 4; up++) {
    const own = (block.textContent ?? "").replace(/\s+/g, " ").trim();
    if (own.length > label.length) break;
    block = block.parentElement;
  }
  if (!block || NEVER.has(block.tagName) || block.getAttribute("role") === "main") return null;
  if ((block.textContent ?? "").length > MAX_LABELLED_BLOCK_CHARS) return null;
  return block;
}

/** Os blocos de anúncio de uma página (ou de uma raiz). */
export function findSponsoredBlocks(root: ParentNode): Set<Element> {
  const blocks = new Set<Element>();
  const consider = (el: Element) => {
    if (NEVER.has(el.tagName) || el.getAttribute("role") === "main") return;
    blocks.add(el);
  };
  try {
    for (const el of Array.from(root.querySelectorAll(SELECTOR))) if (sayssSponsored(el)) consider(el);
  } catch { /* um motor sem algum seletor: o resto ainda vale */ }

  // Os rótulos de texto: só os nós curtos (a maioria do texto da página nem chega ao regex).
  const isDocument = (root as Node).nodeType === 9;
  const doc = isDocument ? (root as Document) : (root as Node).ownerDocument;
  const body = isDocument ? (root as Document).body : (root as Element);
  if (doc && body) {
    const walker = doc.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const raw = node.textContent ?? "";
      if (raw.length === 0 || raw.length > 80) continue;
      const text = raw.replace(/\s+/g, " ").trim();
      if (text.length === 0 || text.length > MAX_LABEL_CHARS || !LABEL_TEXT.test(text)) continue;
      const parent = node.parentElement;
      if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE|OPTION)$/.test(parent.tagName)) continue;
      const block = blockOfLabel(parent, text);
      if (block) blocks.add(block);
    }
  }
  return blocks;
}

/** O elemento está dentro de um bloco de anúncio (ou é ele)? `memo` guarda a resposta por elemento ao longo de um snapshot. */
export function inSponsored(el: Element, blocks: Set<Element>, memo: Map<Element, boolean> = new Map()): boolean {
  if (blocks.size === 0) return false;
  const path: Element[] = [];
  let answer = false;
  for (let node: Element | null = el; node; node = node.parentElement) {
    const known = memo.get(node);
    if (known !== undefined) { answer = known; break; }
    path.push(node);
    if (blocks.has(node)) { answer = true; break; }
  }
  for (const node of path) memo.set(node, answer);
  return answer;
}
