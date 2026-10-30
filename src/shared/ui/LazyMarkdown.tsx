import { lazy, Suspense } from "react";

import type { ImageLoader, MarkdownTone } from "./Markdown";

/**
 * O `Markdown` (react-markdown + remark-gfm) sob demanda, para quem é montado com o app (notas de
 * atualização, paleta de skills) e só mostra markdown quando abre. Até o chunk chegar, o texto cru.
 */
const Impl = lazy(() => import("./Markdown").then((m) => ({ default: m.Markdown })));

export function Markdown({ content, loadImage, tone }: { content: string; loadImage?: ImageLoader; tone?: MarkdownTone }) {
  return (
    <Suspense fallback={<div className={`whitespace-pre-wrap break-words ${tone === "chat" ? "text-chat-prose" : "text-[12px]"}`}>{content}</div>}>
      <Impl content={content} loadImage={loadImage} tone={tone} />
    </Suspense>
  );
}
