import { ReactNode } from "react";

interface PageHeaderProps {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}

/** Encabezado estándar de las páginas de sección (Skills, Marketplace, Sesiones,
 * Workspaces, detalle de skill). Sin botón de "atrás": todas son alcanzables desde el riel
 * de la izquierda, así que un back-button propio era una segunda forma de navegar. El
 * ícono acá es el mismo que identifica a la sección en el riel — ancla visual, no botón. */
export function PageHeader({ icon, title, subtitle, action }: PageHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-3 mb-6">
      <div className="flex items-center gap-3 min-w-0">
        <span className="flex items-center justify-center w-10 h-10 rounded-xl shrink-0
          bg-accent-500/15
          text-accent-600 dark:text-accent-400">
          {icon}
        </span>
        <div className="min-w-0">
          {/* Large title de Apple: 26/32, semibold, tracking apretado. */}
          <h2 className="text-[26px] leading-8 font-semibold tracking-[-0.4px] text-gray-900 dark:text-white truncate">{title}</h2>
          {subtitle && (
            <p className="text-[13px] leading-[18px] text-gray-500 dark:text-white/50 truncate">{subtitle}</p>
          )}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
