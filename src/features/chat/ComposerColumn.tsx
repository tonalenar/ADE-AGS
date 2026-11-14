import { useLayoutEffect, useRef, useState } from "react";

import { composerGutter } from "./composerLayout";
import { useChatWidthClass } from "./chatLook";

/**
 * A margem lateral por faixa de largura do elemento (caixa inteira, sem depender da margem que ele
 * próprio põe). Só muda o estado quando cruza uma das faixas do composer.
 */
export function useColumnGutter<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [gutter, setGutter] = useState(16);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const next = composerGutter(el.offsetWidth);
      setGutter((current) => current === next ? current : next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, style: { paddingInline: gutter } };
}

/** A largura de um elemento, medida (caixa inteira) e acompanhada por `ResizeObserver`; `null` até a primeira medida. */
export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.offsetWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/**
 * A coluna do composer (e do pedido de permissão logo acima): a largura da conversa e a margem pela coluna. É o
 * container `composer` das container queries: com a coluna estreita (o painel do simulador aberto), o nome do modelo
 * trunca (o flex encolhe só o que falta) e «Construir», a pasta e o acesso ficam só com o ícone (o rótulo vai no tooltip), em vez de a linha quebrar.
 */
export function ComposerColumn({ children }: { children: React.ReactNode }) {
  const width = useChatWidthClass();
  const { ref, style } = useColumnGutter<HTMLDivElement>();
  return <div ref={ref} style={style} className={`@container/composer w-full ${width} mx-auto pb-4`}>{children}</div>;
}

/** A altura de um elemento (caixa inteira), acompanhada por `ResizeObserver`; `0` até a primeira medida. */
export function useElementHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setHeight(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, height };
}
