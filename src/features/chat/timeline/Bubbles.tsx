import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { agentIcon } from "@/features/agents/agentIcons";

import { splitAttachmentBlock } from "../attachments/attachModel";
import { AttachmentStrip } from "../attachments/AttachmentStrip";
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
  // Os anexos (bloco `[Anexos]` do fim do texto) viram miniaturas ACIMA do texto, como no Claude Code.
  const { text: body, attachments } = useMemo(() => splitAttachmentBlock(text), [text]);
  return (
    <div className="flex flex-col items-end gap-1" aria-busy={sending || undefined}>
      {attachments.length > 0 && <AttachmentStrip items={attachments} className="justify-end max-w-[85%]" />}
      {body && (
      <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 bg-gray-200/60 dark:bg-white/[0.08] break-words ${sending ? "opacity-70" : ""}`}>
        <Collapsible><div className="whitespace-pre-wrap">{body}</div></Collapsible>
      </div>
      )}
      {sending && <span className="px-2 text-chat-caption text-gray-400 dark:text-white/35">{t("chat.timeline.sending")}</span>}
    </div>
  );
}

/**
 * A fala de um agente, SEM balão (o balão é só da pessoa): texto corrido direto no fundo da página. `header`
 * põe acima do texto o logo e o nome de quem fala (na primeira fala depois da pessoa e quando a voz muda;
 * ver `speakers.ts`). `sender` é o nome de quem fala por `ags peer`.
 */
export function AgentBubble({ agentId, command, label, sender, receipt = null, header = false, entering = false, caret = false, children }: {
  agentId: string;
  command?: string;
  label: string;
  sender?: string;
  /** O número da mensagem de um colega (`ags peer receipt`): fica só na dica, discreto. */
  receipt?: number | null;
  /** Mostra o logo e o nome acima do texto. */
  header?: boolean;
  entering?: boolean;
  caret?: boolean;
  children: React.ReactNode;
}) {
  const Icon = agentIcon(agentId, command);
  const name = sender ?? label;
  return (
    <div title={receipt ? `${name} · #${receipt}` : undefined} className={`min-w-0 flex flex-col gap-1.5 ${entering ? "cc-msg-in" : ""}`}>
      {header && (
        <div className="flex items-center gap-2 text-chat-note font-semibold text-gray-700 dark:text-white/70">
          <span role="img" aria-label={name} title={name} className="shrink-0 w-5 h-5 flex items-center justify-center"><Icon className="w-5 h-5" /></span>
          <span className="truncate">{name}</span>
        </div>
      )}
      <div className="min-w-0 break-words" aria-busy={caret || undefined}>
        <div className={caret ? "cc-stream-caret" : undefined}>{children}</div>
      </div>
    </div>
  );
}
