import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { CodeBlock } from "@/shared/ui/Markdown";

import { CheckIcon, CopyIcon, EyeIcon, PlayIcon } from "../chatIcons";
import { codeLang, runnableCommand } from "../codeRun";
import { VisualReplyPreview } from "./VisualReplyPreview";

/**
 * Quem pode rodar um comando no terminal da conversa aberta (a casca do chat, com a pasta dela). Ausente = o bloco
 * só copia: fora da conversa aberta (o painel do time, por exemplo) não há terminal para onde mandar.
 */
export const RunCodeContext = createContext<((command: string) => void) | null>(null);

/** O renderizador dos blocos de código do chat, para o `Markdown`. */
export function renderChatCodeBlock(block: CodeBlock): React.ReactNode {
  return <CodeBlockFrame {...block} />;
}

/**
 * Um bloco de código do chat, como no Claude Code: a caixa com o código e, à direita, Rodar (só em bloco de shell,
 * e só com um terminal da conversa para onde mandar) e Copiar. Rodar abre o terminal da conversa e manda o comando;
 * nada roda sem o clique.
 */
function CodeBlockFrame({ code, className, pre }: CodeBlock) {
  const { t } = useTranslation();
  const run = useContext(RunCodeContext);
  const language = codeLang(className);
  const command = runnableCommand(language, code);
  const canPreview = (language === "html" || language === "htm") && code.length <= 300_000;
  const [previewOpen, setPreviewOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = () => {
    void navigator.clipboard?.writeText(code.replace(/\n$/, "")).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
  };
  const button = "w-7 h-7 flex items-center justify-center rounded-md text-gray-500 dark:text-white/50 hover:bg-gray-200/70 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white focus-visible:ring-2 focus-visible:ring-accent-500/50";
  return (
    <div data-code-block="" className="my-2 flex items-start rounded-lg border border-gray-200 dark:border-white/8 bg-gray-100 dark:bg-black/30">
      <div className="min-w-0 flex-1">{pre}</div>
      <div className="shrink-0 flex items-center gap-0.5 p-1.5">
        {canPreview && (
          <button type="button" onClick={() => setPreviewOpen(true)} aria-label={t("chat.visualReply.open")} title={t("chat.visualReply.open")} className={button}>
            <EyeIcon className="w-4 h-4" />
          </button>
        )}
        {run && command && (
          <button type="button" onClick={() => run(command)} aria-label={t("chat.code.run")} title={t("chat.code.runHint")} className={button}>
            <PlayIcon className="w-4 h-4" />
          </button>
        )}
        <button type="button" onClick={copy} aria-label={t("chat.code.copy")} title={copied ? t("chat.message.copied") : t("chat.code.copy")} className={button}>
          {copied ? <CheckIcon className="w-4 h-4" /> : <CopyIcon className="w-4 h-4" />}
        </button>
      </div>
      {previewOpen && <VisualReplyPreview html={code} onClose={() => setPreviewOpen(false)} />}
    </div>
  );
}
