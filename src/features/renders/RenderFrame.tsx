import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { DESIGN_SANDBOX } from "@/features/canvas/design/srcdoc";
import { appThemeDeclarations } from "@/features/chat/timeline/isolatedFrame";
import { openExternalUrl } from "@/shared/openExternalUrl";

import { renderRead } from "./ipc";
import { parseRenderMessage, renderSrcdoc } from "./model";

/**
 * O quadro de uma página publicada. O HTML vem do backend e entra em `srcdoc` com sandbox `allow-scripts` (origem
 * opaca: sem acesso ao app, ao IPC nem ao armazenamento). Recarregar é trocar `reloadKey`: relê o arquivo do disco.
 */
export function RenderFrame({ id, reloadKey, title }: { id: string; reloadKey: number; title: string }) {
  const { t } = useTranslation();
  const frame = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setHtml(null);
    setFailed(false);
    renderRead(id)
      .then((text) => {
        if (alive) setHtml(text);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [id, reloadKey]);

  const srcDoc = useMemo(() => (html === null ? null : renderSrcdoc(html, appThemeDeclarations())), [html]);

  // Um link clicado dentro da página chega aqui: abre pela política de links da pessoa (navegador do sistema ou do app).
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const href = parseRenderMessage(event.data);
      if (href) void openExternalUrl(href);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (failed) return <p className="p-4 text-chat-note text-gray-500 dark:text-white/50">{t("renders.unreadable")}</p>;
  if (srcDoc === null) return <p className="p-4 text-chat-note text-gray-400 dark:text-white/40">{t("renders.loading")}</p>;
  return <iframe ref={frame} title={title} sandbox={DESIGN_SANDBOX} srcDoc={srcDoc} className="h-full w-full border-0" />;
}
