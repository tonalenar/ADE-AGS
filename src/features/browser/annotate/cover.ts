/**
 * Tirar do caminho, pelo tempo da foto, o que está POR CIMA da página.
 *
 * A foto é do webview inteiro: um painel flutuante do app (o de uso dos agentes, a dock, outro nó que se sobrepõe) aberto sobre o
 * navegador sairia nela. Em vez de recusar a foto, esconde-se (`visibility: hidden`: o leiaute não se mexe, só some) a RAIZ de cada coisa
 * que cobre e, no `finally`, devolve-se o estilo exato de antes. Dura só o tempo da foto (alguns quadros): não há "pulo" visível.
 */

export interface CoverOptions<E> {
  /** Quem está cobrindo a página agora (os elementos achados pela grade de prova). */
  blockers: () => E[];
  /** A raiz do que cobre: o ramo que NÃO contém a página (nunca a própria página, nem um ancestral dela). `null` = não esconder. */
  rootOf: (blocker: E) => E | null;
  /** Esconde a raiz e devolve como desfazer. */
  hide: (root: E) => () => void;
  /** Rodadas de "olhar de novo": uma raiz escondida pode revelar outra por baixo. */
  maxRounds?: number;
  /** Teto de raízes escondidas: se algo cobre a tela inteira, não se esconde a interface toda por uma foto. */
  maxHidden?: number;
}

export interface Uncovered<E> {
  /** O que foi escondido, em ordem. */
  hidden: E[];
  /** Devolve tudo como estava. Pode ser chamado mais de uma vez. */
  restore: () => void;
}

export function hideCovers<E>({ blockers, rootOf, hide, maxRounds = 3, maxHidden = 6 }: CoverOptions<E>): Uncovered<E> {
  const hidden: E[] = [];
  const undo: (() => void)[] = [];
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const fn of undo.reverse()) {
      try { fn(); } catch { /* o resto precisa voltar mesmo assim */ }
    }
  };
  try {
    for (let round = 0; round < maxRounds; round++) {
      const roots = [...new Set(blockers().map(rootOf).filter((r): r is E => r !== null))].filter((r) => !hidden.includes(r));
      if (roots.length === 0) break;
      for (const root of roots) {
        if (hidden.length >= maxHidden) return { hidden, restore };
        undo.push(hide(root));
        hidden.push(root);
      }
    }
  } catch (error) {
    restore();
    throw error;
  }
  return { hidden, restore };
}

/**
 * A raiz do ramo de `blocker` que não contém `page`: sobe até o filho do primeiro ancestral que contém a página. `null` se o próprio
 * `blocker` é a página, está dentro dela ou a contém (não se esconde a página nem o que a envolve).
 */
export function overlayRootOf(blocker: Element, page: Element): Element | null {
  if (blocker === page || page.contains(blocker) || blocker.contains(page)) return null;
  let node: Element = blocker;
  while (node.parentElement && !node.parentElement.contains(page)) node = node.parentElement;
  return node.parentElement ? node : null;
}

/** Esconde com `visibility: hidden` e devolve o valor INLINE (e a prioridade) que havia antes. */
export function hideElement(el: HTMLElement): () => void {
  const value = el.style.getPropertyValue("visibility");
  const priority = el.style.getPropertyPriority("visibility");
  el.style.setProperty("visibility", "hidden", "important");
  return () => {
    if (value) el.style.setProperty("visibility", value, priority);
    else el.style.removeProperty("visibility");
  };
}
