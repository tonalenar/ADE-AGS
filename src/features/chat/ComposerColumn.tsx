import { useLayoutEffect, useRef, useState } from "react";

import { composerGutter } from "./composerLayout";
import { useChatWidthClass } from "./chatLook";

/**
 * A largura medida de um elemento (a caixa inteira, margens incluídas, que não depende do que o
 * próprio elemento põe de margem: sem laço) e a margem lateral que cabe nela.
 */
export function useColumnGutter<T extends HTMLElement>() {
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
  return { ref, style: { paddingInline: composerGutter(width) } };
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

/** A coluna do composer (e do pedido de permissão logo acima): a largura da conversa e a margem pela coluna. */
export function ComposerColumn({ children }: { children: React.ReactNode }) {
  const width = useChatWidthClass();
  const { ref, style } = useColumnGutter<HTMLDivElement>();
  return <div ref={ref} style={style} className={`w-full ${width} mx-auto pb-4`}>{children}</div>;
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
