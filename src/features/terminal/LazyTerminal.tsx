import { lazy, Suspense, type ComponentProps } from "react";

/**
 * xterm no entra en el arranque. El chunk se pide la primera vez que hay una terminal
 * que pintar: la primera tab, o el login de una cuenta. Con cero tabs el entry no lo
 * descarga.
 *
 * Tema y fit no se mueven de `Terminal`: el constructor aplica el tema y `fitOnce`
 * corre antes de `ptyCreate`. La fuente sigue precargada en `main.tsx`, antes de
 * montar la app, así que medir la celda con la de respaldo (columnas equivocadas)
 * no reaparece por diferir el módulo.
 */
const TerminalView = lazy(() =>
  import("@/features/terminal/Terminal").then((m) => ({ default: m.Terminal })),
);

/** El hueco ya tiene tamaño (lo pone `TerminalPanel`); el fallback solo ocupa ese cuadro. */
function TerminalFallback() {
  return <div className="h-full w-full" aria-busy="true" />;
}

export function Terminal(props: ComponentProps<typeof TerminalView>) {
  return (
    <Suspense fallback={<TerminalFallback />}>
      <TerminalView {...props} />
    </Suspense>
  );
}
