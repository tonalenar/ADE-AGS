import { lazy, Suspense } from "react";

import type { ImageLoader } from "./Markdown";

/**
 * O `Markdown` (react-markdown + remark-gfm) sob demanda, para quem é montado com o app (notas de
 * atualização, paleta de skills) e só mostra markdown quando abre. Até o chunk chegar, o texto cru.
 */
const Impl = lazy(() => import("./Markdown").then((m) => ({ default: m.Markdown })));

export function Markdown({ content, loadImage }: { content: string; loadImage?: ImageLoader }) {
  return (
    <Suspense fallback={<div className="whitespace-pre-wrap break-words text-[12px]">{content}</div>}>
      <Impl content={content} loadImage={loadImage} />
    </Suspense>
  );
}
