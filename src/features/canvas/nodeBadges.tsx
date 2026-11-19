/** Selo de função e ícones de cargo compartilhados entre `AgentNode` (PTY) e `ThreadNode` (protocolo). */
export const ROLE_PILL_BASE =
  "shrink-0 inline-flex h-[18px] items-center rounded-full px-[7px] text-[10px] font-semibold uppercase tracking-[0.06em]";

/** A cor do selo da função (prancheta 1): orquestrador argila, backend azul-claro, frontend roxo, QA laranja. */
export function rolePill(role: string): string {
  const r = role.toLowerCase();
  if (/orq|orch|lead|l[ií]der/.test(r)) return "bg-[rgba(217,119,87,0.16)] text-[#c96442] dark:text-[#d97757]";
  if (/back|api|server/.test(r)) return "bg-[rgba(100,210,255,0.16)] text-sky-600 dark:text-[#64d2ff]";
  if (/front|ui|design/.test(r)) return "bg-[rgba(191,90,242,0.16)] text-purple-600 dark:text-[#bf5af2]";
  if (/qa|test/.test(r)) return "bg-[rgba(255,159,10,0.16)] text-amber-600 dark:text-[#ff9f0a]";
  return "bg-accent-500/15 text-accent-600 dark:text-accent-400";
}

export function PencilIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

export function CrownIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M3 7.5 7.5 11 12 4l4.5 7L21 7.5 19 18H5L3 7.5Z" />
      <rect x="5" y="19.5" width="14" height="2" rx="1" />
    </svg>
  );
}
