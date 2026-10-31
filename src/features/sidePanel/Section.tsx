import { useState, type ReactNode } from "react";
import { Button } from "neogestify-ui-components";

/** O fundo de um cartão do painel: opaco, porque flutua por cima de terminal e canvas. */
export const CARD = `rounded-xl border border-gray-200 dark:border-white/[0.08] bg-gray-50/95 dark:bg-surface-sunken/95
  backdrop-blur-md shadow-lg shadow-black/10 dark:shadow-black/40`;

/** O cartão do painel do chat: arredondado e liso (sem sombra), como o painel do Claude Code. */
export const FLAT_CARD = "rounded-2xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-surface-raised";

const OPEN_KEY = "cc-side-panel-sections";

function loadOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

/** Uma seção que abre e fecha pelo título, como no painel do Claude Code. Lembra o estado. */
export function Section({ id, title, aside, children, defaultOpen = true, flat = false }: {
  id: string;
  title: string;
  /** O resumo à direita do título (uma porcentagem, uma contagem). */
  aside?: ReactNode;
  children?: ReactNode;
  defaultOpen?: boolean;
  /** O cartão liso do painel do chat (`FLAT_CARD`), em vez do cartão flutuante das Abas. */
  flat?: boolean;
}) {
  const [open, setOpen] = useState(() => loadOpen()[id] ?? defaultOpen);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify({ ...loadOpen(), [id]: next }));
    } catch {
      /* não lembrar não impede de abrir */
    }
  };
  return (
    <section className={flat ? FLAT_CARD : CARD}>
      <Button variant="custom" onClick={toggle} aria-expanded={open}
        className={`cc-t flex items-center gap-1.5 w-full px-3 text-left ${flat ? "h-11" : "h-9"}`}>
        <span className="text-[12.5px] font-semibold text-gray-800 dark:text-gray-100">{title}</span>
        <span className={`text-[9px] text-gray-400 dark:text-white/35 transition-transform ${open ? "" : "-rotate-90"}`}>▼</span>
        <span className="flex-1" />
        {aside}
      </Button>
      {open && children && <div className="px-3 pb-3 flex flex-col gap-1">{children}</div>}
    </section>
  );
}

/** Uma linha com ícone; clicável quando tem `onClick`. */
export function Row({ icon, children, onClick, title, trailing }: {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  title?: string;
  trailing?: ReactNode;
}) {
  const body = (
    <>
      {icon && <span className="shrink-0 text-gray-400 dark:text-white/40">{icon}</span>}
      <span className="flex-1 min-w-0 truncate">{children}</span>
      {trailing}
    </>
  );
  const cls = "flex items-center gap-2 min-h-7 px-1.5 -mx-1.5 rounded-md text-[12.5px] text-gray-700 dark:text-gray-200";
  // `div` e não `button`: a linha de uma tarefa leva o botão de parar dentro, e botão dentro de botão não vale.
  return onClick
    ? (
      <div role="button" tabIndex={0} onClick={onClick} title={title}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onClick(); } }}
        className={`cc-t ${cls} cursor-pointer hover:bg-gray-200/60 dark:hover:bg-white/[0.06]`}>{body}</div>
    )
    : <div title={title} className={cls}>{body}</div>;
}
