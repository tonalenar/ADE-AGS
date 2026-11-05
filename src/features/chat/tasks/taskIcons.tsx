/** Os ícones do painel de tarefas, no traço dos ícones do chat (`chatIcons.tsx`). */
type IconProps = { className?: string };

function Svg({ className = "w-4 h-4", children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {children}
    </svg>
  );
}

/** O botão do cabeçalho: uma lista com um relógio (o que roda sozinho). */
export const TasksIcon = (p: IconProps) => <Svg {...p}><path d="M4 6h9M4 12h6M4 18h6" /><circle cx="17" cy="15" r="4" /><path d="M17 13.2V15l1.2.8" /></Svg>;
export const TrashIcon = (p: IconProps) => <Svg {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></Svg>;
/** Expandir (↗↙): as setas para fora. */
export const ExpandIcon = (p: IconProps) => <Svg {...p}><path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" /></Svg>;
/** Restaurar: as setas para dentro. */
export const CollapseIcon = (p: IconProps) => <Svg {...p}><path d="M20 10h-6V4M14 10l7-7M4 14h6v6M10 14l-7 7" /></Svg>;
export const ChevronRightIcon = (p: IconProps) => <Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>;
export const ArrowLeftIcon = (p: IconProps) => <Svg {...p}><path d="M19 12H5M11 18l-6-6 6-6" /></Svg>;
