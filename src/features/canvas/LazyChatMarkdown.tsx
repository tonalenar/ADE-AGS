import { lazy, Suspense } from "react";

/**
 * O chat abre com o app, mas o react-markdown + remark-gfm (~156 KB) não precisa ir no entry: vem num
 * chunk quando a primeira mensagem aparece. Até lá o texto aparece cru, com as quebras de linha.
 */
const Impl = lazy(() => import("./ChatMarkdown").then((m) => ({ default: m.ChatMarkdown })));

export function ChatMarkdown({ text }: { text: string }) {
  return (
    <Suspense fallback={<div className="chat-md min-w-0 whitespace-pre-line break-words [overflow-wrap:anywhere]">{text}</div>}>
      <Impl text={text} />
    </Suspense>
  );
}
