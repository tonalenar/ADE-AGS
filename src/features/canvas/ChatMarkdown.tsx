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

function CodeBlock({ children }: { children: ReactNode }) {
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
    <div className="group/code relative my-2">
      <pre className="max-h-72 overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-3 pr-14 text-[11.5px] leading-snug
        dark:border-white/10 dark:bg-black/30" tabIndex={0}>
        {children}
      </pre>
      <button type="button" onClick={copy} aria-label={t("canvas.chat.copyCode")} title={t("canvas.chat.copyCode")}
        className="absolute right-1.5 top-1.5 rounded-md border border-gray-200 bg-white/90 px-1.5 py-0.5 text-[10px] font-medium text-gray-600
          opacity-70 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent-400
          dark:border-white/12 dark:bg-gray-900/90 dark:text-gray-300">
        {copied ? t("canvas.chat.copied") : t("canvas.chat.copy")}
      </button>
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
          h1: (p) => <h1 className="mt-2 mb-1 text-[14px] font-bold" {...p} />,
          h2: (p) => <h2 className="mt-2 mb-1 text-[13.5px] font-bold" {...p} />,
          h3: (p) => <h3 className="mt-1.5 mb-0.5 text-[13px] font-semibold" {...p} />,
          h4: (p) => <h4 className="mt-1.5 mb-0.5 text-[12.5px] font-semibold" {...p} />,
          // `pre-line`: los saltos de línea simples del agente se respetan, como en una terminal.
          p: (p) => <p className="my-1.5 whitespace-pre-line first:mt-0 last:mb-0" {...p} />,
          ul: (p) => <ul className="my-1.5 flex list-disc flex-col gap-0.5 pl-5" {...p} />,
          ol: (p) => <ol className="my-1.5 flex list-decimal flex-col gap-0.5 pl-5" {...p} />,
          hr: () => <hr className="my-2 border-gray-300 dark:border-white/12" />,
          blockquote: (p) => <blockquote className="my-2 border-l-2 border-gray-300 pl-3 text-gray-500 dark:border-white/20 dark:text-gray-400" {...p} />,
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          code: ({ className, children, ...rest }) => {
            const block = /language-/.test(className ?? "") || textOf(children).includes("\n");
            return block
              ? <code className="block font-mono" {...rest}>{children}</code>
              : <code className="rounded bg-black/8 px-1 py-0.5 font-mono text-[11.5px] dark:bg-white/12" {...rest}>{children}</code>;
          },
          table: (p) => <div className="my-2 max-w-full overflow-x-auto"><table className="border-collapse text-[11.5px]" {...p} /></div>,
          th: (p) => <th className="border-b border-gray-300 px-2 py-1 text-left font-semibold dark:border-white/15" {...p} />,
          td: (p) => <td className="border-b border-gray-200 px-2 py-1 dark:border-white/8" {...p} />,
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
