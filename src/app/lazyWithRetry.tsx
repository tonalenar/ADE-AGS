import { lazy, useContext, type ComponentProps, type ComponentType } from "react";

import { RetryAttemptContext } from "@/app/PanelBoundary";

/**
 * `React.lazy` que sabe tentar de novo. O React guarda a rejeição do primeiro import dentro do próprio
 * `lazy`, então um "Tentar de novo" que só re-renderiza repetiria o erro para sempre. Aqui cada tentativa
 * do boundary (ver `RetryAttemptContext`) cria um `lazy` novo, e o import é feito de novo.
 *
 * Fora de um `PanelBoundary` a tentativa é sempre 0: comporta-se como um `lazy` comum.
 */
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): ComponentType<ComponentProps<T>> {
  // Um `lazy` por tentativa, guardado: re-renderizar a mesma tentativa reusa o mesmo componente lazy.
  const porTentativa = new Map<number, ComponentType<ComponentProps<T>>>();

  function ChunkComTentativa(props: ComponentProps<T>) {
    const tentativa = useContext(RetryAttemptContext);
    let Componente = porTentativa.get(tentativa);
    if (!Componente) {
      Componente = lazy(factory) as ComponentType<ComponentProps<T>>;
      porTentativa.set(tentativa, Componente);
    }
    return <Componente {...props} />;
  }
  return ChunkComTentativa;
}
