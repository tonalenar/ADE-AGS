import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "neogestify-ui-components";

export interface ContextMenuItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  /** Se ve pero no se puede elegir (pegar sin nada copiado). */
  disabled?: boolean;
  /** Una línea arriba: separa grupos de acciones. */
  separator?: boolean;
  /** El atajo que hace lo mismo, a la derecha. Solo informa. */
  hint?: string;
  onSelect: () => void;
}

/** Cuánto aire se le deja al menú contra el borde de la ventana al reubicarlo. */
const EDGE = 8;

/**
 * El menú de click derecho, uno solo para toda la app.
 *
 * ## Por qué sale por un portal y por la capa superior
 *
 * Un menú contextual tiene que dibujarse ENCIMA de todo, y en la práctica eso no se
 * consigue con un z-index alto. El z-index solo ordena dentro del contexto de apilamiento
 * del ancestro más cercano que cree uno — y acá los crea casi cualquier cosa: un panel con
 * una animación de opacidad en efecto, el encabezado del lateral con su z-index propio, un
 * contenedor con `transform`. Adentro de cualquiera de esos, un 10000 no sirve de nada: el
 * menú queda tapado por el panel de al lado.
 *
 * Dos capas de defensa, de más fuerte a más compatible:
 *
 * 1. `popover` promueve el elemento a la CAPA SUPERIOR del navegador, que se pinta después
 *    de todo el documento y no participa de ningún contexto de apilamiento. Es la única
 *    forma de estar arriba de verdad.
 * 2. Si el motor no la soporta (WebKitGTK viejo), el portal a `<body>` ya saca al menú de
 *    todos los contextos de la app, y ahí sí el z-index alcanza.
 *
 * Se reubica si no entra: abrirlo cerca del borde derecho o inferior dejaba la mitad de las
 * opciones fuera de la ventana, y con la ventana sin decoración no hay scroll que valga —
 * lo que se sale, se pierde.
 */
export function ContextMenu({ x, y, items, onClose }: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    // `showPopover` tira si ya está abierto o si el elemento no está conectado; ninguna
    // de las dos es motivo para quedarse sin menú.
    try {
      el.showPopover?.();
    } catch {
      /* sin capa superior; queda el portal, que para esta app alcanza */
    }

    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - width - EDGE),
      y: Math.min(y, window.innerHeight - height - EDGE),
    });
  }, [x, y, items.length]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Se corta acá: si no, el Escape sigue hasta la terminal de atrás.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      popover="manual"
      // Solo lo que de verdad hay que pelearle a la hoja de estilos del navegador: a todo
      // lo que sea `popover` le pone `inset: 0; margin: auto` para centrarlo, y sin anular
      // esas dos el menú aparece en el medio de la pantalla en vez de donde se hizo click.
      // `inset` va ANTES que `top`/`left`: React aplica las claves en orden, y al revés
      // las dejaría en `auto`.
      //
      // El resto (fondo, borde, padding) lo ponen las clases, y una declaración de autor
      // ya le gana a la del navegador. Repetirlas acá en línea las pisaría — el menú
      // quedaba transparente y sin borde.
      style={{
        inset: "auto",
        position: "fixed",
        top: pos.y,
        left: pos.x,
        margin: 0,
        zIndex: 10000,
      }}
      className="cc-pop min-w-52 p-1 rounded-lg border overflow-hidden
        bg-white/80 dark:bg-surface-raised/80 backdrop-blur-xl
        border-gray-200 dark:border-white/[0.08]
        shadow-[0_0_0_0.5px_rgba(255,255,255,0.08),0_10px_30px_rgba(0,0,0,0.45),0_2px_6px_rgba(0,0,0,0.3)]
        text-gray-800 dark:text-white
        text-[13px] select-none"
    >
      {items.map((item) => (
        <div key={item.key}>
          {item.separator && <div className="my-1 mx-1.5 h-px bg-gray-200 dark:bg-white/[0.08]" />}
          {/* 26px de alto, como los menús de macOS. El destacado es el fondo accent con texto
              blanco, y el atalho en mono se aclara igual para seguir leyéndose sobre él. */}
          <Button variant="custom"
            disabled={item.disabled}
            onClick={() => { item.onSelect(); onClose(); }}
            className={`group cc-t w-full h-[26px] flex items-center gap-2 px-2 rounded-[5px] text-left
              disabled:opacity-40 disabled:pointer-events-none
              ${item.danger
                ? "text-red-500 dark:text-red-400 hover:bg-red-500 hover:text-white"
                : "hover:bg-accent-500 hover:text-white"}`}
          >
            {item.icon && <span className="shrink-0 flex w-3.5 h-3.5">{item.icon}</span>}
            <span className="flex-1 truncate">{item.label}</span>
            {item.hint && (
              <span className="shrink-0 pl-4 font-mono text-[11px] tabular-nums text-gray-400 dark:text-white/35
                group-hover:text-white/75">{item.hint}</span>
            )}
          </Button>
        </div>
      ))}
    </div>,
    document.body
  );
}
