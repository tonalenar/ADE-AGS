import { Button, Tooltip } from "neogestify-ui-components";

/**
 * Un botón de ícono de la barra del navegador. `plain`: con el rótulo nativo del sistema en
 * vez del tooltip de la app — para lo que dispara una captura, porque el tooltip de la app
 * se dibuja en la página y saldría en la foto; el del sistema no.
 */
export function ToolButton({ label, onClick, disabled, active, plain, children }: {
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  active?: boolean;
  plain?: boolean;
  children: React.ReactNode;
}) {
  const button = (
    <Button
      variant="icon"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={plain ? label : undefined}
      // Contraste de texto, no de adorno: estos son los controles con los que se usa la
      // tab. Con el gris al 45% sobre el fondo oscuro, y encima atenuados al 35% mientras
      // la página no cargó, prácticamente no se veían.
      className={`cc-t relative flex items-center justify-center size-6 p-0 rounded-md shrink-0
        disabled:opacity-100 disabled:cursor-default disabled:text-gray-400 dark:disabled:text-white/30 disabled:hover:bg-transparent
        ${active
          ? "bg-accent-500/15 text-accent-600 dark:bg-accent-400/20 dark:text-accent-300"
          : "text-gray-700 dark:text-gray-200 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10"}`}
    >
      {children}
    </Button>
  );
  return plain ? button : <Tooltip content={label} placement="bottom">{button}</Tooltip>;
}

/** Una acción propia de esta tab, con rótulo. Marcar y enviar no son iconos que alguien
 *  reconozca de un navegador: sin la palabra al lado había que pasar el mouse para saber
 *  qué hacían. `plain`: ver `ToolButton`. */
export function ActionButton({ hint, onClick, disabled, active, plain, children }: {
  hint: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  active?: boolean;
  plain?: boolean;
  children: React.ReactNode;
}) {
  const button = (
    <Button
      variant="custom"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={plain ? hint : undefined}
      className={`cc-t flex items-center gap-1.5 h-8 px-2.5 rounded-lg shrink-0 border text-[12px] font-semibold
        disabled:opacity-45 disabled:hover:bg-transparent
        ${active
          ? "bg-accent-600 border-accent-600 text-white hover:bg-accent-500"
          : "border-gray-300 dark:border-white/15 text-gray-800 dark:text-gray-100 hover:bg-gray-200 dark:hover:bg-white/10"}`}
    >
      {children}
    </Button>
  );
  return plain ? button : <Tooltip content={hint} placement="bottom">{button}</Tooltip>;
}

/** La raya que separa grupos de botones. */
export function ToolbarSeparator() {
  return <div className="w-px h-5 mx-0.5 shrink-0 bg-gray-200 dark:bg-white/10" />;
}

/** Um item do menu "⋯" do navegador: ícone, rótulo e, à direita, um valor ou um contador. */
export function MenuRow({ icon, label, onClick, disabled, checked, trailing }: {
  icon?: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Item que liga e desliga: mostra o estado ao lado. */
  checked?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      disabled={disabled}
      onClick={onClick}
      className="cc-t flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12.5px]
        text-gray-800 hover:bg-gray-100 disabled:opacity-45 disabled:hover:bg-transparent
        dark:text-gray-100 dark:hover:bg-white/10"
    >
      <span className="flex w-4 shrink-0 items-center justify-center text-gray-500 dark:text-white/55">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
      {checked && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-600 dark:bg-accent-400" />}
    </button>
  );
}

/** A linha que separa grupos do menu. */
export function MenuDivider() {
  return <div role="separator" className="my-1 h-px bg-gray-200 dark:bg-white/10" />;
}
