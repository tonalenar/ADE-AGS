import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { agentIcon } from "@/features/agents/agentIcons";

import { COLLAPSED_PX, overflowsLimit } from "./bubbleModel";
import { prefersReducedMotion } from "./useRevealedText";

/**
 * O conteúdo de um balão com o limite de altura: passando dele, recolhe com o fim apagado por uma
 * máscara (`cc-bubble-fade`, vale em qualquer cor de fundo, clara ou escura) e o botão "Mostrar mais"
 * logo abaixo, ainda dentro do balão. A altura anima (`max-height`), sem salto; sem movimento
 * reduzido a transição some. Texto curto não ganha botão.
 */
export function Collapsible({ children, innerClass = "" }: { children: React.ReactNode; innerClass?: string }) {
  const { t } = useTranslation();
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    if (inner.current) setHeight(inner.current.offsetHeight);
  });
  useEffect(() => {
    const el = inner.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const long = overflowsLimit(height);
  const collapsed = long && !open;
  return (
    <>
      <div style={long ? { maxHeight: open ? height : COLLAPSED_PX } : undefined}
        className={`overflow-hidden ${long && !prefersReducedMotion() ? "transition-[max-height] duration-200 ease-out" : ""} ${collapsed ? "cc-bubble-fade" : ""}`}>
        <div ref={inner} className={innerClass}>{children}</div>
      </div>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
          className="mt-1 text-chat-ui text-gray-900 dark:text-white hover:underline">
          {open ? t("chat.timeline.showLess") : t("chat.timeline.showMore")}
        </button>
      )}
    </>
  );
}

/** A mensagem da pessoa: balão à direita. `sending` = ainda não voltou do agente. */
export function PersonBubble({ text, sending = false }: { text: string; sending?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-end gap-0.5" aria-busy={sending || undefined}>
      <div className={`max-w-[80%] rounded-3xl px-4 py-3 bg-gray-200/60 dark:bg-white/[0.08] break-words ${sending ? "opacity-70" : ""}`}>
        <Collapsible><div className="whitespace-pre-wrap">{text}</div></Collapsible>
      </div>
      {sending && <span className="px-2 text-chat-caption text-gray-400 dark:text-white/35">{t("chat.timeline.sending")}</span>}
    </div>
  );
}

/**
 * A fala de um agente, SEM balão: texto corrido direto no fundo da página, como no Claude Code. `header`
 * põe acima do texto uma linha discreta com o logo pequeno e o nome de quem fala (só num time, quando o
 * remetente muda; ver `speakers.ts`). `sender` é o nome de quem fala por `ags peer`.
 */
export function AgentBubble({ agentId, command, label, sender, header = false, entering = false, caret = false, children }: {
  agentId: string;
  command?: string;
  label: string;
  sender?: string;
  /** Mostra o logo e o nome acima do texto. */
  header?: boolean;
  entering?: boolean;
  caret?: boolean;
  children: React.ReactNode;
}) {
  const Icon = agentIcon(agentId, command);
  const name = sender ?? label;
  return (
    <div className={`min-w-0 flex flex-col gap-1.5 ${entering ? "cc-msg-in" : ""}`}>
      {header && (
        <div className="flex items-center gap-1.5 text-chat-caption font-medium text-gray-500 dark:text-white/50">
          <span role="img" aria-label={name} title={name} className="shrink-0 w-4 h-4 flex items-center justify-center"><Icon className="w-4 h-4" /></span>
          <span className="truncate">{name}</span>
        </div>
      )}
      <div className="min-w-0 break-words" aria-busy={caret || undefined}>
        <div className={caret ? "cc-stream-caret" : undefined}>{children}</div>
      </div>
    </div>
  );
}
