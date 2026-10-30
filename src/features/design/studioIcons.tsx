/** Ícones de traço da tela de Design (16×16, cor do texto). */
type P = { className?: string };
const base = (className = "w-4 h-4") => ({
  className, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4,
  strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true,
});

export const SelectIcon = ({ className }: P) => <svg {...base(className)}><path d="M3.5 2.5l9 5-4 1.2-1.6 3.8z" /></svg>;
export const HandIcon = ({ className }: P) => (
  <svg {...base(className)}><path d="M5 8V4a1 1 0 012 0v3.5M7 7V3a1 1 0 012 0v4M9 7V3.8a1 1 0 012 0V8M11 6.5a1 1 0 012 0V9a5 5 0 01-5 5h-.5a4 4 0 01-3.2-1.6L2.6 10a1 1 0 011.6-1.2L5 9.8" /></svg>
);
export const FrameIcon = ({ className }: P) => <svg {...base(className)}><path d="M5 1.5v13M11 1.5v13M1.5 5h13M1.5 11h13" /></svg>;
export const NoteIcon = ({ className }: P) => <svg {...base(className)}><path d="M2.5 2.5h11v7l-4 4h-7z" /><path d="M9.5 13.5v-4h4" /></svg>;
export const CommentIcon = ({ className }: P) => <svg {...base(className)}><path d="M2.5 13.5V7a4.5 4.5 0 014.5-4.5h2A4.5 4.5 0 0113.5 7v0A4.5 4.5 0 019 11.5H5z" /></svg>;
export const CaretIcon = ({ className }: P) => <svg {...base(className ?? "w-3 h-3")}><path d="M4 6l4 4 4-4" /></svg>;
export const CheckIcon = ({ className }: P) => <svg {...base(className ?? "w-3.5 h-3.5")}><path d="M3 8.5l3.2 3L13 4.5" /></svg>;
export const DotsIcon = ({ className }: P) => (
  <svg {...base(className)} fill="currentColor" stroke="none"><circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" /></svg>
);
export const ExpandIcon = ({ className }: P) => <svg {...base(className)}><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9" /></svg>;
export const BackIcon = ({ className }: P) => <svg {...base(className)}><path d="M10 3L5 8l5 5" /></svg>;
export const PlusIcon = ({ className }: P) => <svg {...base(className)}><path d="M8 3v10M3 8h10" /></svg>;
/** O cursor do agente (seta cheia). */
export const AgentCursorIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 16 16" aria-hidden="true"><path d="M2 1.5l11 6.2-4.6 1.3-2 4.5z" fill="currentColor" stroke="white" strokeWidth="1.2" strokeLinejoin="round" /></svg>
);
export const TextIcon = ({ className }: P) => <svg {...base(className)}><path d="M3 3.5h10M8 3.5v9.5M6 13h4" /></svg>;
export const PencilIcon = ({ className }: P) => <svg {...base(className)}><path d="M10.5 2.5l3 3-8 8H2.5v-3z" /><path d="M9 4l3 3" /></svg>;
export const PenIcon = ({ className }: P) => <svg {...base(className)}><path d="M8 1.5l4.5 6-4.5 7-4.5-7z" /><circle cx="8" cy="8" r="1.2" /></svg>;
export const RectIcon = ({ className }: P) => <svg {...base(className)}><rect x="2.5" y="3.5" width="11" height="9" rx="1" /></svg>;
export const OvalIcon = ({ className }: P) => <svg {...base(className)}><ellipse cx="8" cy="8" rx="5.5" ry="4.5" /></svg>;
export const LineIcon = ({ className }: P) => <svg {...base(className)}><path d="M3 13L13 3" /></svg>;
export const ArrowIcon = ({ className }: P) => <svg {...base(className)}><path d="M3 13L13 3M7.5 3H13v5.5" /></svg>;
export const PanelIcon = ({ className }: P) => <svg {...base(className)}><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M10 2.5v11" /></svg>;
export const ExportIcon = ({ className }: P) => <svg {...base(className)}><path d="M8 2.5v8M5 7.5l3 3 3-3M3 12.5v1h10v-1" /></svg>;
export const PlayIcon = ({ className }: P) => <svg {...base(className)} fill="currentColor" stroke="none"><path d="M5 3.5l7.5 4.5L5 12.5z" /></svg>;
export const StopIcon = ({ className }: P) => <svg {...base(className)} fill="currentColor" stroke="none"><rect x="4" y="4" width="8" height="8" rx="1" /></svg>;
