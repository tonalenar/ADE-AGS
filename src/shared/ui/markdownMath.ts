import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";

/**
 * A matemática do Markdown das conversas, como no T3 Code: fórmulas `$…$` e `$$…$$` (remark-math) e o
 * KaTeX que as desenha (rehype-katex). Sem HTML cru: o KaTeX só gera o próprio markup. Quem não liga a
 * preferência "Renderizar matemática" não usa estes plugins, e o `$` continua texto.
 */

/** O nó do mdast que a regra lê: só o tipo, o texto e os filhos. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

/**
 * O remark-math aceita `$5 e $10` como fórmula ("5 e ") porque não exige que o `$` de fechamento venha
 * colado ao conteúdo. As regras do Pandoc, que o T3 segue: o `$` de abertura não pode ser seguido de
 * espaço; o de fechamento não pode ser precedido de espaço nem seguido de dígito. Um trecho que não casa
 * com isso volta a ser texto, com os mesmos caracteres. Muta a árvore. Pura.
 */
export function rejectCurrencyMath(node: MdNode): void {
  const kids = node.children;
  if (!kids) return;
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    if (child.type === "inlineMath" && !isPandocMath(child, kids[i + 1])) {
      kids.splice(i, 1, { type: "text", value: `$${child.value ?? ""}$` });
      continue;
    }
    rejectCurrencyMath(child);
  }
}

/** Um trecho entre `$` que atende às regras do Pandoc: nada de espaço colado aos cifrões e sem dígito logo depois. */
function isPandocMath(node: MdNode, next: MdNode | undefined): boolean {
  const value = node.value ?? "";
  if (/^\s|\s$/.test(value)) return false;
  return !(next?.type === "text" && /^\d/.test(next.value ?? ""));
}

/** O plugin do remark que aplica `rejectCurrencyMath` à árvore inteira. */
const remarkCurrencyGuard = () => (tree: MdNode) => {
  rejectCurrencyMath(tree);
};

/** Os plugins de leitura da matemática: remark-math mais a regra do cifrão. Somam-se ao remark-gfm. */
export const MATH_REMARK_PLUGINS = [remarkMath, remarkCurrencyGuard];

/** O plugin que desenha as fórmulas com KaTeX. */
export const MATH_REHYPE_PLUGINS = [rehypeKatex];
