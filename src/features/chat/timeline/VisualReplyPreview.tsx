import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ViewModal } from "@/shared/ui/ViewModal";
import { useTranslation } from "react-i18next";

import { useDesignFrame } from "@/shared/ipc/designFrame";

import { appThemeDeclarations, ISOLATED_FRAME_CSP, ISOLATED_FRAME_SANDBOX } from "./isolatedFrame";

/** Quem envia o aviso de saída de dentro da prévia: o script que `visualReplyDocument` injeta. */
export const VISUAL_REPLY_SOURCE = "ags-visual-reply";

/**
 * Fase da prévia quando o quadro sai da página: `ok` (quadro normal), `restored` (o documento congelado voltou ao
 * quadro, com aviso) e `blocked` (o quadro foi tirado; só o aviso fica).
 */
export type FramePhase = "ok" | "restored" | "blocked";

/** A próxima fase quando o quadro sai da página: a primeira saída restaura o documento; a seguinte tira o quadro. Pura. */
export function nextFramePhase(phase: FramePhase): FramePhase {
  return phase === "ok" ? "restored" : "blocked";
}

/** O HTML do agente roda em srcdoc opaco, sem origem da ADE; a CSP restringe conexões, recursos e formulários externos. */
export function visualReplyDocument(html: string): string {
  const { dark, declarations } = appThemeDeclarations();
  const scheme = dark ? "dark" : "light";
  const policy = ISOLATED_FRAME_CSP;
  const theme = `:root{${declarations};color-scheme:${scheme}}*{box-sizing:border-box}html,body{min-height:100%;margin:0}body{min-height:100vh;padding:24px;font-family:var(--font-sans,system-ui,sans-serif);color:var(--color-gray-900,CanvasText);background:var(--color-gray-50,Canvas)}html[data-ade-scheme="dark"] body{color:var(--color-gray-100,CanvasText);background:var(--color-surface-deep,Canvas)}`;
  // Clique em link não navega. Se o próprio HTML sai da página por script (`location.href`), o `beforeunload` manda o
  // aviso ao pai. O navegador não deixa o script cancelar essa saída: quem reage é o pai (`VisualReplyPreview`).
  const guard = `document.addEventListener('click',function(e){var a=e.target instanceof Element?e.target.closest('a[href]'):null;if(a)e.preventDefault()},true);window.addEventListener('beforeunload',function(){try{parent.postMessage({source:'${VISUAL_REPLY_SOURCE}',kind:'navigate-away'},'*')}catch(x){}});`;
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width, initial-scale=1"><html data-ade-scheme="${scheme}"><style>${theme}</style><script>${guard}</script>${html}`;
}

export function VisualReplyPreview({ html, onClose }: { html: string; onClose: () => void }) {
  const { t } = useTranslation();
  const frame = useRef<HTMLIFrameElement>(null);
  // A prévia mostra o HTML como estava ao abrir. Se o bloco mudar com a janela aberta, o quadro não recarrega, e o
  // aviso de saída da página antiga não vira bloqueio falso.
  const [opened] = useState(() => html);
  const docHtml = useMemo(() => visualReplyDocument(opened), [opened]);
  const frameDoc = useDesignFrame(docHtml, "isolated");
  const [phase, setPhase] = useState<FramePhase>("ok");
  // Chave do iframe: cada restauração troca a chave, e o React monta um quadro novo (o documento de fora é descartado).
  const [frameKey, setFrameKey] = useState(0);
  const phaseRef = useRef<FramePhase>("ok");
  // Chave do quadro cujo primeiro `load` já passou: o primeiro é o carregamento esperado, o seguinte é uma saída.
  const loadedKey = useRef<number | null>(null);

  // Saída da página (aviso do guarda ou segundo `load`): a primeira restaura o documento congelado e mostra o aviso;
  // a seguinte tira o quadro. O destino de fora nunca fica na tela. Usa refs, então é estável entre renderizações.
  const leave = useCallback(() => {
    const next = nextFramePhase(phaseRef.current);
    phaseRef.current = next;
    setPhase(next);
    if (next === "restored") setFrameKey((key) => key + 1);
  }, []);

  // Só o aviso vindo do quadro desta prévia conta (a janela do iframe é a fonte).
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { source?: unknown; kind?: unknown } | null;
      if (data?.source === VISUAL_REPLY_SOURCE && data.kind === "navigate-away") leave();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [leave]);

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
        {phase !== "ok" && (
          <p role="status" className="shrink-0 px-4 py-2 text-sm text-gray-600 dark:text-white/70">
            {t("chat.visualReply.blocked")}
          </p>
        )}
        {phase !== "blocked" && frameDoc.ready && (
          <iframe
            key={frameKey}
            ref={frame}
            title={t("chat.visualReply.frameTitle")}
            sandbox={ISOLATED_FRAME_SANDBOX}
            referrerPolicy="no-referrer"
            src={frameDoc.src}
            srcDoc={frameDoc.srcDoc}
            onLoad={() => {
              if (loadedKey.current !== frameKey) {
                loadedKey.current = frameKey;
                return;
              }
              leave();
            }}
            className="min-h-0 w-full flex-1 border-0 bg-white dark:bg-surface-deep"
          />
        )}
      </div>
    </ViewModal>
  );
}
