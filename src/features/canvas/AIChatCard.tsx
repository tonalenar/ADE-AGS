import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

/** The 21st.dev AI chat card layout, with controlled input and live conversation content. */
export interface AIChatCardProps {
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
  composerHint, children, className = "", style, chrome, onKeyDown,
}: AIChatCardProps) {
  return (
    <section aria-label={title} style={style} onKeyDown={onKeyDown} className={`ai-chat-card flex min-h-0 flex-col overflow-hidden rounded-[24px]
      border border-gray-200 bg-white text-gray-900 dark:border-white/12 dark:bg-surface-deep dark:text-gray-50
      shadow-[0_0_16.4px_1px_rgba(10,10,10,0.05),0_8px_32px_rgba(0,0,0,0.12)]
      dark:shadow-[0_8px_32px_rgba(0,0,0,0.4)] ${className}`}>
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-gray-200 px-5 pb-4 pt-5 dark:border-white/10">
        <div className="min-w-0">
          <h3 className="text-[16px] font-medium leading-6">{title}</h3>
          {subtitle && <p title={subtitle} className="mt-0.5 truncate text-[13px] leading-5 text-gray-500 dark:text-gray-400">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </header>

      {chrome}
      {toolbar}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
        {children ?? <div className="flex min-h-full flex-col items-center justify-center px-3 py-6 text-center">
          <div className="ai-chat-card-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-gray-100 dark:bg-white/6">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
              <path d="M8 4.8A8 8 0 0 1 20 12c0 4.4-3.6 8-8 8a8 8 0 0 1-3.5-.8L4 20l.8-4.5A8 8 0 0 1 8 4.8Z" strokeDasharray="3 3" />
            </svg>
          </div>
          <p className="ai-chat-card-reveal mt-4 text-[18px] font-medium leading-7 tracking-[-0.45px]">{greeting}</p>
          <p className="ai-chat-card-reveal mt-1.5 max-w-[220px] text-[13px] leading-[22.75px] text-gray-500 dark:text-gray-400"
            style={{ animationDelay: "100ms" } as CSSProperties}>{prompt}</p>
        </div>}
      </div>

      <form className="shrink-0 px-5 pb-5 pt-1" onSubmit={(event) => { event.preventDefault(); onSend(); }}>
        <div className="rounded-[18px] bg-gray-200/50 p-3 transition-colors focus-within:bg-gray-200/70 dark:bg-white/7 dark:focus-within:bg-white/10">
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
            className="block max-h-32 w-full resize-none bg-transparent text-[13px] leading-5 outline-none placeholder:text-gray-500 dark:placeholder:text-gray-400 disabled:opacity-50"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="min-w-0 text-[11px] text-gray-500 dark:text-gray-400">{composerHint}</div>
            <button type="submit" disabled={disabled || busy || !message.trim()} aria-label={sendLabel} title={sendLabel}
              className="group flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-gray-950 text-white transition-transform hover:scale-110 active:scale-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400 disabled:opacity-35 disabled:hover:scale-100 dark:bg-white dark:text-gray-950">
              {busy ? <span aria-hidden>…</span> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 transition-transform group-hover:-translate-y-px" aria-hidden>
                <path d="M12 19V5m-6 6 6-6 6 6" />
              </svg>}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
