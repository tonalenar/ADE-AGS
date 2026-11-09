import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "neogestify-ui-components";

import { openExternalUrl } from "@/shared/openExternalUrl";
import { htmlImagesToMarkdown } from "./htmlImages";

/** Trae una imagen y devuelve algo que un `<img>` puede mostrar (un `data:`). */
export type ImageLoader = (src: string) => Promise<string>;

/** Una imagen que se pide recién al dibujarse. Mientras llega, o si falla, queda el texto
 *  alternativo — un hueco en blanco no dice que ahí había algo. */
function LoadedImage({ src, alt, load }: { src: string; alt: string; load: ImageLoader }) {
  const [data, setData] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Por ref: quien lo usa puede pasar una función nueva en cada render, y eso no es
  // motivo para volver a pedir la misma imagen.
  const loader = useRef(load);
  loader.current = load;

  useEffect(() => {
    let stale = false;
    setData(null);
    setFailed(false);
    loader.current(src)
      .then((d) => { if (!stale) setData(d); })
      .catch(() => { if (!stale) setFailed(true); });
    return () => { stale = true; };
  }, [src]);

  if (!data) {
    return (
      <Button variant="custom"
        onClick={() => openUrl(src).catch(console.error)}
        title={src}
        className={`text-[11px] italic text-gray-400 dark:text-white/30 hover:underline
          ${failed ? "" : "animate-pulse"} inline-block`}
      >
        🖼 {alt || src.split("/").pop()}
      </Button>
    );
  }
  return (
    <img
      src={data}
      alt={alt}
      onClick={() => openUrl(src).catch(console.error)}
      className="inline-block max-w-full h-auto my-1 rounded-md cursor-zoom-in
        border border-gray-200 dark:border-white/10"
    />
  );
}

/**
 * Markdown renderizado, para leer una skill sin instalarla.
 *
 * ## Lo que NO hace, a propósito
 *
 * No renderiza HTML crudo. `react-markdown` lo ignora salvo que se le agregue `rehype-raw`,
 * y acá no se agrega: este texto viene de un repositorio ajeno, así que es entrada no
 * confiable. Un `<script>` o un `<iframe>` dentro de un SKILL.md no tiene por qué poder
 * ejecutarse en la ventana de la app.
 *
 * Las imágenes no se cargan salvo que quien lo usa pase `loadImage`: bajar una imagen
 * remota le cuenta al servidor de turno que abriste esa skill, y en una app de escritorio
 * eso es filtrar tu IP por mirar un catálogo. Sin él se muestra el texto alternativo. Los
 * PRs e issues sí lo pasan: son de tus repos, y las capturas son la mitad del reporte.
 *
 * Os links HTTP(S) seguem a preferência de navegador da ADE. Abrir no Browser cria uma
 * superfície própria e não substitui a janela do app.
 */
/**
 * Os tamanhos de cada tom. `compact` é o de sempre (skills, PRs, notas); `chat` é o da conversa do
 * modo chat, com a escala do Claude (tokens `text-chat-*` do `App.css`).
 */
export type MarkdownTone = "compact" | "chat";

const TONE: Record<MarkdownTone, { root: string; h1: string; h2: string; h3: string; code: string; table: string }> = {
  compact: {
    root: "text-[12.5px] leading-relaxed text-gray-700 dark:text-gray-300",
    h1: "text-base font-bold",
    h2: "text-sm font-bold",
    h3: "text-[13px] font-semibold",
    code: "text-[11.5px]",
    table: "text-[11.5px]",
  },
  chat: {
    root: "text-chat-prose text-gray-800 dark:text-gray-200",
    h1: "text-chat-title font-semibold",
    h2: "text-chat-prose font-semibold",
    h3: "text-chat-prose font-medium",
    code: "text-chat-code",
    table: "text-chat-ui",
  },
};

/** Um bloco de código (` ``` `): o texto, a classe de linguagem (`language-bash`) e o `<pre>` já desenhado. */
export interface CodeBlock {
  code: string;
  className: string | null;
  pre: React.ReactNode;
}

/** Quem usa o markdown pode envolver cada bloco de código (o chat põe Rodar e Copiar). */
export type CodeBlockRenderer = (block: CodeBlock) => React.ReactNode;

/** Um nó da árvore que o `react-markdown` passa aos componentes (hast), só o que se lê aqui. */
interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

/** O texto de um nó, com os filhos. */
function hastText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

/** O texto e a classe do `<code>` dentro de um `<pre>`. Puro. */
export function codeOfPre(node: HastNode | undefined): { code: string; className: string | null } {
  const code = node?.children?.find((c) => c.type === "element" && c.tagName === "code");
  const raw = code?.properties?.className;
  const className = Array.isArray(raw) ? raw.join(" ") : typeof raw === "string" ? raw : null;
  return { code: hastText(code ?? node), className };
}

export function Markdown({ content, loadImage, tone = "compact", renderCodeBlock }: { content: string; loadImage?: ImageLoader; tone?: MarkdownTone; renderCodeBlock?: CodeBlockRenderer }) {
  const size = TONE[tone];
  // El frontmatter no es prosa: sin sacarlo, los `---` se renderizan como una línea
  // horizontal y los campos como un párrafo suelto arriba de todo. Los datos que trae ya
  // se muestran aparte, en la cabecera.
  const body = useMemo(() => htmlImagesToMarkdown(stripFrontmatter(content)), [content]);

  // Os componentes ficam os mesmos entre um render e outro. Funções novas a cada render fazem o React desmontar e
  // remontar o markdown de todas as falas da conversa a cada mensagem nova: a rolagem e o estado dos blocos de código se perdem.
  const components = useMemo<Components>(() => ({
    h1: (p) => <h1 className={`${size.h1} text-gray-900 dark:text-white mt-2`} {...p} />,
    h2: (p) => <h2 className={`${size.h2} text-gray-900 dark:text-white mt-3`} {...p} />,
    h3: (p) => <h3 className={`${size.h3} text-gray-800 dark:text-gray-100 mt-2`} {...p} />,
    p: (p) => <p className="my-1.5" {...p} />,
    ul: (p) => <ul className="list-disc pl-5 my-1.5 flex flex-col gap-1" {...p} />,
    ol: (p) => <ol className="list-decimal pl-5 my-1.5 flex flex-col gap-1" {...p} />,
    hr: () => <hr className="my-3 border-gray-200 dark:border-white/10" />,
    blockquote: (p) => (
        <blockquote
          className="border-l-2 border-gray-300 dark:border-white/15 pl-3 my-2
            text-gray-500 dark:text-gray-400"
          {...p}
        />
    ),
    code: ({ className, children, ...rest }) => {
        // `react-markdown` usa el mismo componente para el código en línea y para el
        // de bloque; el de bloque llega con una clase `language-*` y envuelto en <pre>.
        const isBlock = /language-/.test(className ?? "");
        return isBlock ? (
          <code className={`font-mono ${size.code} block`} {...rest}>{children}</code>
        ) : (
          <code
            className={`font-mono ${size.code} px-1 py-0.5 rounded
              bg-gray-100 dark:bg-white/8 text-gray-800 dark:text-gray-200`}
            {...rest}
          >
            {children}
          </code>
        );
    },
    pre: ({ node, ...p }) => {
        // Com moldura de quem usa, a caixa (fundo e borda) é dela: o `<pre>` fica só com o recuo.
        const pre = (
          <pre
            className={renderCodeBlock ? "m-0 p-3 overflow-x-auto" : `my-2 p-3 rounded-lg overflow-x-auto
              bg-gray-100 dark:bg-black/30
              border border-gray-200 dark:border-white/8`}
            {...p}
          />
        );
        if (!renderCodeBlock) return pre;
        return renderCodeBlock({ ...codeOfPre(node as HastNode | undefined), pre });
    },
    table: (p) => (
        <div className="my-2 overflow-x-auto">
          <table className={`${size.table} border-collapse`} {...p} />
        </div>
    ),
    th: (p) => (
        <th className="text-left font-semibold px-2 py-1 border-b
          border-gray-200 dark:border-white/10" {...p} />
    ),
    td: (p) => <td className="px-2 py-1 border-b border-gray-100 dark:border-white/5" {...p} />,
    a: ({ href, children }) => (
        <Button variant="custom"
          onClick={() => { if (href) openExternalUrl(href).catch(console.error); }}
          className="text-accent-600 dark:text-accent-400 hover:underline text-left inline-block"
        >
          {children}
        </Button>
    ),
    img: ({ alt, src }) => (loadImage && typeof src === "string" && src ? (
        <LoadedImage src={src} alt={alt ?? ""} load={loadImage} />
    ) : (
        <span className="text-[11px] italic text-gray-400 dark:text-white/30">
          {alt ? `🖼 ${alt}` : null}
        </span>
    )),
  }), [size, renderCodeBlock]);

  return (
    <div className={`flex flex-col gap-3 ${size.root}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

/** Saca el bloque `---` inicial de un SKILL.md. Si no hay, devuelve el texto igual. */
export function stripFrontmatter(content: string): string {
  return splitFrontmatter(content).body;
}

/**
 * Separa el bloque `---` inicial del resto. `frontmatter` es su contenido, sin las rayas;
 * `null` si el archivo no tiene (y entonces `body` es el texto tal cual).
 */
export function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const text = content.replace(/^\uFEFF/, "");
  if (!/^---\r?\n/.test(text)) return { frontmatter: null, body: content };
  // El cierre tiene que estar al principio de una línea: un `---` en medio de la prosa
  // (una línea horizontal, por ejemplo) no cierra nada.
  const end = text.search(/\r?\n---[ \t]*(\r?\n|$)/);
  if (end === -1) return { frontmatter: null, body: content };
  return {
    frontmatter: text.slice(text.indexOf("\n") + 1, end),
    body: text.slice(text.indexOf("\n", end + 1) + 1).replace(/^\s*\n/, ""),
  };
}
