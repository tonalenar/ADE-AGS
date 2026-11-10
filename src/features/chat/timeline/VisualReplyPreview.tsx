import { ViewModal } from "@/shared/ui/ViewModal";
import { useTranslation } from "react-i18next";

import { appThemeDeclarations, ISOLATED_FRAME_CSP } from "./isolatedFrame";

/** O HTML do agente roda em srcdoc opaco, sem origem da ADE; a CSP restringe conexões, recursos e formulários externos. */
export function visualReplyDocument(html: string): string {
  const { dark, declarations } = appThemeDeclarations();
  const scheme = dark ? "dark" : "light";
  const policy = ISOLATED_FRAME_CSP;
  const theme = `:root{${declarations};color-scheme:${scheme}}*{box-sizing:border-box}html,body{min-height:100%;margin:0}body{min-height:100vh;padding:24px;font-family:var(--font-sans,system-ui,sans-serif);color:var(--color-gray-900,CanvasText);background:var(--color-gray-50,Canvas)}html[data-ade-scheme="dark"] body{color:var(--color-gray-100,CanvasText);background:var(--color-surface-deep,Canvas)}`;
  const blockLinks = "document.addEventListener('click',function(e){var a=e.target instanceof Element?e.target.closest('a[href]'):null;if(a)e.preventDefault()},true);";
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width, initial-scale=1"><html data-ade-scheme="${scheme}"><style>${theme}</style><script>${blockLinks}</script>${html}`;
}

export function VisualReplyPreview({ html, onClose }: { html: string; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <ViewModal
      title={t("chat.visualReply.title")}
      fill
      onClose={onClose}
      closeOnEsc
      closeOnBackdrop
      bodyClassName="!overflow-hidden !p-0"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 border-b border-gray-200 px-4 py-2 text-xs text-gray-500 dark:border-white/10 dark:text-gray-400">
          {t("chat.visualReply.isolated")}
        </div>
        <iframe
          title={t("chat.visualReply.frameTitle")}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={visualReplyDocument(html)}
          className="min-h-0 w-full flex-1 border-0 bg-white dark:bg-surface-deep"
        />
      </div>
    </ViewModal>
  );
}
