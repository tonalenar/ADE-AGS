import { useId } from "react";

/**
 * El marco de una sección de Configuración.
 *
 * Antes cada sección repetía a mano la misma tarjeta con degradado, borde y sombra — la
 * cadena estaba copiada en cinco archivos, y cambiarla implicaba acordarse de los cinco.
 * Ahora el marco vive acá y las secciones solo traen su contenido.
 *
 * Y ya no es una tarjeta: Configuración se abre dentro de un modal que YA pone marco,
 * fondo y sombra. Lo que separa una sección de la siguiente es el título grande y el aire,
 * como en Ajustes del macOS.
 */
export function SettingsSection({ title, description, action, children }: {
  title: string;
  description?: string;
  /** Control que pertenece al encabezado y no al cuerpo (un botón de "agregar", un toggle). */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex max-w-3xl flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          <h3 className="text-[20px] leading-[26px] font-semibold tracking-[-0.01em] text-gray-900 dark:text-white">
            {title}
          </h3>
          {description && (
            <p className="text-[12px] leading-4 text-gray-500 dark:text-white/50">
              {description}
            </p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * Lista agrupada tipo Ajustes del macOS: un cartón redondeado con filas de 40px separadas
 * por hairline. Cada hijo directo es una fila.
 */
export function SettingsGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl
      bg-gray-100/70 dark:bg-surface-raised/60
      divide-y divide-gray-200 dark:divide-white/[0.08]">
      {children}
    </div>
  );
}

/** Una fila de ajuste: etiqueta a la izquierda, control o valor a la derecha. */
export function SettingsRow({ label, hint, children }: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 min-h-10 px-3 py-2">
      <span className="flex flex-col gap-px min-w-0">
        <span className="truncate text-[13px] leading-[18px] text-gray-900 dark:text-gray-100">{label}</span>
        {hint && (
          <span className="truncate text-[11.5px] leading-4 text-gray-500 dark:text-white/40">{hint}</span>
        )}
      </span>
      <span className="shrink-0 flex items-center">{children}</span>
    </div>
  );
}

/**
 * Fila con interruptor estilo iOS (38x22, encendido en verde). Es un botón con
 * `role="switch"`: Espacio y Enter lo alternan y el foco se ve. `children` va debajo de la
 * fila, para avisos del mismo ajuste.
 */
export function SettingsToggleRow({ label, description, checked, disabled = false, onChange, children }: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  children?: React.ReactNode;
}) {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1 px-3 py-2.5">
      <div className="flex items-center justify-between gap-4">
        <span className="flex flex-col gap-px min-w-0">
          <span id={labelId} className="text-[13px] leading-[18px] text-gray-900 dark:text-gray-100">{label}</span>
          {description && (
            <span className="text-[11.5px] leading-4 text-gray-500 dark:text-white/40">{description}</span>
          )}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-labelledby={labelId}
          disabled={disabled}
          onClick={() => onChange(!checked)}
          className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors
            motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/30
            disabled:opacity-50 ${checked ? "bg-emerald-500" : "bg-gray-300 dark:bg-surface-overlay"}`}
        >
          <span aria-hidden="true"
            className={`absolute left-[2px] top-[2px] h-[18px] w-[18px] rounded-full bg-white
              shadow-[0_2px_4px_rgba(0,0,0,0.35)] transition-transform motion-reduce:transition-none
              ${checked ? "translate-x-4" : ""}`} />
        </button>
      </div>
      {children}
    </div>
  );
}
