/** Ícones das ferramentas de marcação do visualizador (traço 1.6, 24×24, cor do texto). */
type P = { className?: string };
const base = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

export const HighlighterIcon = ({ className }: P) => <svg {...base} className={className}><path d="m9 11-5 5v3h3l5-5" /><path d="m14 4 6 6-7 7-6-6z" /><path d="M4 21h16" /></svg>;
export const ArrowToolIcon = ({ className }: P) => <svg {...base} className={className}><path d="M5 19 19 5" /><path d="M10 5h9v9" /></svg>;
export const RectToolIcon = ({ className }: P) => <svg {...base} className={className}><rect x="4" y="6" width="16" height="12" rx="1.5" /></svg>;
export const EllipseToolIcon = ({ className }: P) => <svg {...base} className={className}><ellipse cx="12" cy="12" rx="8.5" ry="6.5" /></svg>;
export const TextToolIcon = ({ className }: P) => <svg {...base} className={className}><path d="M5 6V5h14v1" /><path d="M12 5v14" /><path d="M9 19h6" /></svg>;
export const StepToolIcon = ({ className }: P) => <svg {...base} className={className}><circle cx="12" cy="12" r="8.5" /><path d="M10.5 9.5 12.5 8v8" /></svg>;
export const BlurToolIcon = ({ className }: P) => <svg {...base} className={className}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 9.5h16M4 14.5h16M9.5 4v16M14.5 4v16" opacity=".55" /></svg>;
export const EraserToolIcon = ({ className }: P) => <svg {...base} className={className}><path d="m7 21-4-4 11-11 7 7-8 8z" /><path d="M7 21h13" /><path d="m9.5 10.5 7 7" /></svg>;
export const MagicEraseIcon = ({ className }: P) => <svg {...base} className={className}><path d="m14 4 6 6-9 9H6l-2-2 10-13z" /><path d="M3 6h3M4.5 4.5v3M18 18h3M19.5 16.5v3" /></svg>;
export const ResizeToolIcon = ({ className }: P) => <svg {...base} className={className}><path d="M14 4h6v6" /><path d="M10 20H4v-6" /><path d="M20 4l-7 7M4 20l7-7" /></svg>;
export const CommentToolIcon = ({ className }: P) => <svg {...base} className={className}><path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7l-4 3v-3H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" /></svg>;
export const SaveCopyIcon = ({ className }: P) => <svg {...base} className={className}><path d="M6 4h9l4 4v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" /><path d="M8 4v5h6V4" /><path d="M9 20v-6h6v6" /></svg>;
export const ClipboardToolIcon = ({ className }: P) => <svg {...base} className={className}><rect x="6" y="4" width="12" height="17" rx="1.5" /><path d="M9 4V3h6v1" /><path d="M9 10h6M9 14h4" /></svg>;
export const RedoIcon = ({ className }: P) => <svg {...base} className={className}><path d="M15 6l4 4-4 4" /><path d="M19 10H9a5 5 0 0 0 0 10h3" /></svg>;
export const UndoIcon2 = ({ className }: P) => <svg {...base} className={className}><path d="M9 6 5 10l4 4" /><path d="M5 10h10a5 5 0 0 1 0 10h-3" /></svg>;
