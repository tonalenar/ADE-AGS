import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

/** The 21st.dev AI chat card layout, with controlled input and live conversation content. */
export interface AIChatCardProps {
  /** Substitui título/subtítulo por um cabeçalho próprio (ex.: o seletor de conversas). */
  heading?: ReactNode;
  title: string;
  subtitle?: string;
  greeting: string;
  prompt: string;
  placeholder: string;
  inputLabel: string;
  sendLabel: string;
  message: string;
  onMessageChange: (message: string) => void;
  onSend: () => void;
  busy?: boolean;
  disabled?: boolean;
  actions?: ReactNode;
  toolbar?: ReactNode;
  composerHint?: ReactNode;
  /** Ferramentas à direita do compositor, antes do enviar (ex.: Chat | Plano). */
  composerRight?: ReactNode;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Capa sobre la tarjeta (los puxadores de tamaño). */
  chrome?: ReactNode;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
}

export function AIChatCard({
  title, subtitle, greeting, prompt, placeholder, inputLabel, sendLabel, message,
  onMessageChange, onSend, busy = false, disabled = false, actions, toolbar,
  composerHint, composerRight, children, className = "", style, chrome, onKeyDown, heading,
}: AIChatCardProps) {
  return (
    <section aria-label={title} style={style} onKeyDown={onKeyDown} className={`ai-chat-card flex min-h-0 flex-col overflow-hidden rounded-xl
      border border-black/[0.08] bg-white/95 text-gray-900 backdrop-blur-xl
      dark:border-white/[0.08] dark:bg-surface/90 dark:text-gray-50
      shadow-[0_0_0_0.5px_rgba(10,10,10,0.06),0_10px_30px_rgba(0,0,0,0.12)]
      dark:shadow-[0_0_0_0.5px_rgba(255,255,255,0.08),0_10px_30px_rgba(0,0,0,0.45),0_2px_6px_rgba(0,0,0,0.3)] ${className}`}>
      {heading ? (
        <header className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
          <div className="min-w-0 flex-1">{heading}</div>
          {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
        </header>
      ) : (
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-black/[0.08] px-4 pb-3 pt-4 dark:border-white/[0.08]">
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold leading-5 tracking-[-0.01em]">{title}</h3>
            {subtitle && <p title={subtitle} className="mt-0.5 truncate font-mono text-[11.5px] leading-[15px] tabular-nums text-gray-500 dark:text-gray-400">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
        </header>
      )}

      {chrome}
      {toolbar}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        {children ?? <div className="flex min-h-full flex-col items-center justify-center px-3 py-6 text-center">
          <div className="ai-chat-card-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gray-100 dark:bg-surface-raised">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 text-gray-500 dark:text-gray-400" aria-hidden>
              <path d="M8 4.8A8 8 0 0 1 20 12c0 4.4-3.6 8-8 8a8 8 0 0 1-3.5-.8L4 20l.8-4.5A8 8 0 0 1 8 4.8Z" strokeDasharray="3 3" />
            </svg>
          </div>
          <p className="ai-chat-card-reveal mt-4 text-[15px] font-semibold leading-5 tracking-[-0.01em]">{greeting}</p>
          <p className="ai-chat-card-reveal mt-1.5 max-w-[220px] text-[12.5px] leading-[17px] text-gray-500 dark:text-gray-400"
            style={{ animationDelay: "100ms" } as CSSProperties}>{prompt}</p>
        </div>}
      </div>

      <form className="shrink-0 px-3 pb-3 pt-1" onSubmit={(event) => { event.preventDefault(); onSend(); }}>
        <div className="rounded-xl border border-black/[0.08] bg-gray-100 p-2.5 transition-[border-color,box-shadow] duration-150
          focus-within:border-accent-500 focus-within:ring-[3px] focus-within:ring-accent-500/25
          dark:border-white/[0.08] dark:bg-surface-raised">
          <textarea
            value={message}
            onChange={(event) => onMessageChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                onSend();
              }
            }}
            disabled={disabled || busy}
            placeholder={placeholder}
            aria-label={inputLabel}
            rows={2}
            className="block max-h-32 w-full resize-none bg-transparent text-[13.5px] leading-[19px] outline-none placeholder:text-gray-500 dark:placeholder:text-white/[0.32] disabled:opacity-50"
          />
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1 text-[11px] text-gray-500 dark:text-gray-400">{composerHint}</div>
            {composerRight}
            <button type="submit" disabled={disabled || busy || !message.trim()} aria-label={sendLabel} title={sendLabel}
              className="group flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-500 text-white transition-transform hover:scale-105 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400 disabled:opacity-35 disabled:hover:scale-100">
              {busy ? <span aria-hidden>…</span> : <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px] transition-transform group-hover:-translate-y-px" aria-hidden>
                <path d="M8 13V3.2M3.8 7.4 8 3.2l4.2 4.2" />
              </svg>}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
