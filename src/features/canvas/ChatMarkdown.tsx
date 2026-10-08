import { Children, isValidElement, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Solo http/https salen del chat. Cualquier otro esquema (`javascript:`, `file:`, `data:`,
 * `tauri:`…) o un enlace relativo se descarta: el texto lo escribió un agente y no es de
 * confianza. Devuelve la URL normalizada o `null`.
 */
export function safeHref(href: string | undefined | null): string | null {
  if (!href) return null;
  try {
    const url = new URL(href.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** El texto plano de un árbol de React (para copiar el contenido de un bloque de código). */
export function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(Children.toArray(node.props.children));
  return "";
}

/** El lenguaje del bloque (`language-ts` → `ts`), solo para mostrarlo en la cabecera. */
function langOf(node: ReactNode): string {
  if (!isValidElement<{ className?: string }>(node)) return "";
  return /language-([\w+#.-]+)/.exec(node.props.className ?? "")?.[1] ?? "";
}

function CodeBlock({ lang, children }: { lang: string; children: ReactNode }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = textOf(children).replace(/\n$/, "");
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
  };
  return (
    <div className="group/code my-2 overflow-hidden rounded-lg border border-black/[0.08] bg-gray-50 dark:border-white/[0.08] dark:bg-surface-deep">
      <div className="flex h-7 items-center gap-2 border-b border-black/[0.08] pl-3 pr-1.5 dark:border-white/[0.08]">
        <span className="min-w-0 truncate font-mono text-[11px] text-gray-500 dark:text-gray-400">{lang}</span>
        <button type="button" onClick={copy} aria-label={t("canvas.chat.copyCode")} title={t("canvas.chat.copyCode")}
          className="ml-auto flex h-5 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-gray-500 hover:text-gray-900
            focus-visible:outline-2 focus-visible:outline-accent-400 dark:text-gray-400 dark:hover:text-white">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="h-[13px] w-[13px]" aria-hidden>
            <rect x="5.2" y="5.2" width="8" height="8" rx="1.8" /><path d="M3.2 10.6V3.8a1.6 1.6 0 0 1 1.6-1.6h6.8" />
          </svg>
          {copied ? t("canvas.chat.copied") : t("canvas.chat.copy")}
        </button>
      </div>
      {/* `!`: el contenedor de la conversación (ChatPanel) pinta `pre` por su cuenta; aquí el fondo
          y el relleno son los del bloque, no los del contenedor. */}
      <pre className="!m-0 !rounded-none !bg-transparent !p-3 max-h-72 overflow-auto font-mono text-[11.5px] leading-4 text-gray-900 dark:text-gray-100" tabIndex={0}>
        {children}
      </pre>
    </div>
  );
}

/**
 * Markdown de las respuestas de los agentes. Seguro a propósito: `react-markdown` no
 * interpreta HTML crudo (no hay `rehype-raw` ni `dangerouslySetInnerHTML`), los enlaces solo
 * pueden ser http/https y abren en el navegador del sistema, y las imágenes no se cargan
 * (traerlas le contaría al servidor de turno que se leyó el mensaje).
 */
export function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="chat-md min-w-0 break-words [overflow-wrap:anywhere]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          h1: (p) => <h1 className="mt-2 mb-1 text-[14px] font-semibold tracking-[-0.01em]" {...p} />,
          h2: (p) => <h2 className="mt-2 mb-1 text-[13.5px] font-semibold tracking-[-0.01em]" {...p} />,
          h3: (p) => <h3 className="mt-1.5 mb-0.5 text-[13px] font-semibold" {...p} />,
          h4: (p) => <h4 className="mt-1.5 mb-0.5 text-[12.5px] font-semibold" {...p} />,
          // `pre-line`: los saltos de línea simples del agente se respetan, como en una terminal.
          p: (p) => <p className="my-1.5 whitespace-pre-line first:mt-0 last:mb-0" {...p} />,
          ul: (p) => <ul className="my-1.5 flex list-disc flex-col gap-0.5 pl-5" {...p} />,
          ol: (p) => <ol className="my-1.5 flex list-decimal flex-col gap-0.5 pl-5" {...p} />,
          hr: () => <hr className="my-2 border-black/[0.08] dark:border-white/[0.08]" />,
          blockquote: (p) => <blockquote className="my-2 border-l-2 border-gray-300 pl-3 text-gray-500 dark:border-white/[0.16] dark:text-gray-400" {...p} />,
          pre: ({ children }) => <CodeBlock lang={langOf(children)}>{children}</CodeBlock>,
          code: ({ className, children, ...rest }) => {
            const block = /language-/.test(className ?? "") || textOf(children).includes("\n");
            return block
              ? <code className="block font-mono" {...rest}>{children}</code>
              : <code className="rounded-[5px] bg-gray-100 px-1 py-px font-mono text-[11.5px] dark:bg-surface-raised" {...rest}>{children}</code>;
          },
          table: (p) => <div className="my-2 max-w-full overflow-x-auto"><table className="border-collapse text-[11.5px]" {...p} /></div>,
          th: (p) => <th className="border-b border-gray-300 px-2 py-1 text-left font-semibold dark:border-white/[0.16]" {...p} />,
          td: (p) => <td className="border-b border-black/[0.06] px-2 py-1 dark:border-white/[0.08]" {...p} />,
          a: ({ href, children }) => {
            const safe = safeHref(href);
            if (!safe) return <span className="underline decoration-dotted">{children}</span>;
            return (
              <a href={safe} title={safe} rel="noreferrer noopener" className="text-accent-600 underline hover:text-accent-500 dark:text-accent-300"
                onClick={(e) => { e.preventDefault(); openUrl(safe).catch(console.error); }}>
                {children}
              </a>
            );
          },
          img: ({ alt }) => <span className="text-[11px] italic opacity-60">{alt ? `🖼 ${alt}` : null}</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
