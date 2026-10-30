import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { agentIcon } from "@/features/agents/agentIcons";

import { COLLAPSED_PX, overflowsLimit } from "./bubbleModel";
import { prefersReducedMotion } from "./useRevealedText";

/** O logo do agente ao lado do balão (o mesmo `agentIcon` de todo o app). */
export function AgentAvatar({ agentId, command, label }: { agentId: string; command?: string; label: string }) {
  const Icon = agentIcon(agentId, command);
  return (
    <span title={label} role="img" aria-label={label}
      className="shrink-0 w-7 h-7 mt-0.5 rounded-full flex items-center justify-center bg-gray-100 dark:bg-white/[0.08]">
      <Icon className="w-4 h-4" />
    </span>
  );
}

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

/** A fala de um agente: o logo ao lado e o balão, sempre inteiro (só as mensagens da pessoa recolhem em "Mostrar mais"). `sender` mostra o nome (quem fala por `ags peer`). */
export function AgentBubble({ agentId, command, label, sender, entering = false, caret = false, children }: {
  agentId: string;
  command?: string;
  label: string;
  sender?: string;
  entering?: boolean;
  caret?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex items-start gap-2.5 ${entering ? "cc-msg-in" : ""}`}>
      <AgentAvatar agentId={agentId} command={command} label={sender ?? label} />
      <div className="min-w-0 max-w-[88%] flex flex-col gap-1">
        {sender && <span className="px-1 text-chat-caption font-medium text-gray-500 dark:text-white/45">{sender}</span>}
        <div className={`rounded-3xl px-4 py-3 bg-gray-100 dark:bg-white/[0.05] break-words`} aria-busy={caret || undefined}>
          <div className={caret ? "cc-stream-caret" : undefined}>{children}</div>
        </div>
      </div>
    </div>
  );
}
