import { useId } from "react";

/**
 * El marco de una sección de Configuración.
 *
 * Antes cada sección repetía a mano la misma tarjeta con degradado, borde y sombra — la
 * cadena estaba copiada en cinco archivos, y cambiarla implicaba acordarse de los cinco.
 * Ahora el marco vive acá y las secciones solo traen su contenido.
 *
 * Es el aspecto de la prancheta 5, el mismo en Pestañas, Canvas y Chat: el título grande es el
 * de la página; el de la sección va chico, encima de sus tarjetas.
 */
export function SettingsSection({ title, description, action, children }: {
  title: string;
  description?: string;
  /** Control que pertenece al encabezado y no al cuerpo (un botón de "agregar", un toggle). */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex items-end gap-3 mx-1">
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <h2 className="m-0 text-[13px] font-medium text-gray-500 dark:text-white/50">{title}</h2>
          {description && <p className="m-0 text-[12.5px] leading-[18px] text-gray-400 dark:text-white/40">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * Lista agrupada: una tarjeta con borde y filas separadas por hairline. Cada hijo directo es
 * una fila. Sin `overflow-hidden`: los menús de una fila (el selector de modelo, Permisos) se
 * abren por fuera de la tarjeta.
 */
export function SettingsGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col rounded-xl border border-gray-200 dark:border-white/[0.08]
      bg-white dark:bg-white/[0.03] divide-y divide-gray-200 dark:divide-white/[0.08]">
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
    <div className="flex items-center justify-between gap-4 px-4 py-3.5">
      <span className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[14px] font-medium text-gray-900 dark:text-white">{label}</span>
        {hint && <span className="text-[13px] text-gray-500 dark:text-white/50">{hint}</span>}
      </span>
      <span className="shrink-0 flex items-center">{children}</span>
    </div>
  );
}

/**
 * Fila con interruptor (`ChatSwitch`). Es un botón con `role="switch"`: Espacio y Enter lo
 * alternan y el foco se ve. `children` va debajo de la
 * fila, para avisos del mismo ajuste.
 */
export function SettingsToggleRow({ label, description, checked, disabled = false, onChange, badge, children }: {
  label: string;
  description?: string;
  /** Um selo ao lado do nome (o modo de um ponto do Jev, por exemplo). */
  badge?: React.ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  children?: React.ReactNode;
}) {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1 px-4 py-3.5">
      <div className="flex items-center justify-between gap-4">
        <span className="flex flex-col gap-0.5 min-w-0">
          <span className="flex items-center gap-2">
            <span id={labelId} className="text-[14px] font-medium text-gray-900 dark:text-white">{label}</span>
            {badge}
          </span>
          {description && <span className="text-[13px] text-gray-500 dark:text-white/50">{description}</span>}
        </span>
        <ChatSwitch labelId={labelId} checked={checked} disabled={disabled} onChange={onChange} />
      </div>
      {children}
    </div>
  );
}

/** A chave das Configurações (prancheta 5): 36×20, ligada na cor de destaque. */
export function ChatSwitch({ labelId, label, checked, disabled = false, onChange }: {
  labelId?: string;
  label?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-labelledby={labelId} aria-label={labelId ? undefined : label}
      disabled={disabled} onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors motion-reduce:transition-none
        focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 disabled:opacity-50
        ${checked ? "bg-accent-600" : "bg-gray-300 dark:bg-white/15"}`}>
      <span aria-hidden="true"
        className={`absolute left-[2px] top-[2px] h-4 w-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)]
          transition-transform motion-reduce:transition-none ${checked ? "translate-x-4" : ""}`} />
    </button>
  );
}

/** O segmentado das Configurações (prancheta 5): opções numa faixa cinza, a escolhida em branco. */
export function ChatSegmented<T extends string>({ label, options, value, onChange }: {
  label: string;
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex gap-0.5 p-0.5 rounded-lg bg-gray-100 dark:bg-white/[0.06]">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}
          className={`h-6 px-2.5 rounded-md text-[12px] font-medium
            ${value === o.value
              ? "bg-white dark:bg-white/[0.12] text-gray-900 dark:text-white shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
              : "text-gray-500 dark:text-white/50 hover:text-gray-900 dark:hover:text-white"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
