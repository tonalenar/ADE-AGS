import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { Button } from "neogestify-ui-components";

import { chatShellOn, useUiStore } from "@/app/uiStore";
import { canvasActions, setWorkMode, useCanvasStore } from "@/features/canvas/store";
import { browserScope } from "@/features/chat/columnTabs";
import { setColumnTabResource, setRightPanel, useChatStore } from "@/features/chat/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";

import { cancelCaptchaHandoff, useCaptchaStore, type CaptchaHandoff } from "./captchaStore";
import { previewCaptchaNotify } from "./ipc";

/** Foca a aba ou o portal do agente onde o captcha precisa ser resolvido pela pessoa. */
export function focusCaptchaView(handoff: CaptchaHandoff, navigate: (to: string) => void): void {
  const viewStore = useViewTabsStore.getState();
  const isPortal = Boolean(handoff.portalId) || viewStore.portalViews.some((v) => v.id === handoff.viewId);

  if (isPortal) {
    const portalId = handoff.portalId ?? handoff.viewId;
    const boards = useCanvasStore.getState().boards;
    const boardKey = Object.keys(boards).find((key) => portalId in (boards[key]?.portals ?? {}));
    const ui = useUiStore.getState();
    if (chatShellOn(ui)) ui.setShellMode("workspace");
    if (boardKey) {
      setWorkMode(boardKey, "canvas");
      canvasActions.focusRef(boardKey, portalId);
    }
    navigate("/workspace");
    return;
  }

  const ui = useUiStore.getState();
  if (chatShellOn(ui)) {
    const chat = useChatStore.getState();
    if (chat.panel !== "browser") setRightPanel("browser");
    const browserTab = chat.columnTabs.find((tab) => tab.id === chat.columnActive && tab.kind === "browser");
    if (browserTab) {
      setColumnTabResource(browserTab.id, browserScope(handoff.cwd, handoff.owner), handoff.viewId);
    }
  }
  viewStore.activateView(handoff.viewId);
  navigate("/workspace");
}

/**
 * Cartão exibido quando um agente encontra um captcha e precisa que a pessoa resolva.
 *
 * A ADE nunca resolve captcha sozinha: este cartão mostra qual agente está parado, em qual site,
 * foca a aba/portal ao clicar em "Resolver agora" e permite cancelar a espera. Quando a janela
 * não está em foco, dispara a notificação nativa do sistema pelo mesmo mecanismo dos avisos.
 */
export function CaptchaHandoffCard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const handoffsMap = useCaptchaStore((s) => s.handoffs);
  const seen = useRef<Set<string>>(new Set());

  const pending = useMemo(
    () => Object.values(handoffsMap).sort((a, b) => a.since - b.since),
    [handoffsMap],
  );

  useEffect(() => {
    const fresh = pending.filter((h) => !seen.current.has(h.id));
    seen.current = new Set(pending.map((h) => h.id));
    if (fresh.length === 0) return;

    for (const item of fresh) {
      const title = t("browser.captcha.notifyTitle");
      const body = t("browser.captcha.notifyBody", { agent: item.agentName, site: item.site });
      previewCaptchaNotify(title, body).catch(() => undefined);
    }
    if (typeof document !== "undefined" && !document.hasFocus()) {
      getCurrentWindow().requestUserAttention(UserAttentionType.Informational).catch(() => undefined);
    }
  }, [pending, t]);

  const current = pending[0];
  if (!current) return null;

  const others = pending.length - 1;

  return (
    <div
      role="alertdialog"
      aria-label={t("browser.captcha.title")}
      className="cc-rise w-[360px] max-w-[calc(100vw-2rem)] rounded-xl shadow-2xl overflow-hidden
        border border-amber-300/70 dark:border-amber-500/30 bg-white dark:bg-surface-raised"
    >
      <div className="flex items-start gap-2.5 px-4 pt-3">
        <span className="relative flex w-2 h-2 mt-1.5 shrink-0">
          <span className="absolute inset-0 rounded-full bg-amber-500 animate-ping opacity-60" />
          <span className="relative w-2 h-2 rounded-full bg-amber-500" />
        </span>
        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
          <span className="text-[13px] font-semibold text-gray-900 dark:text-white">
            {t("browser.captcha.title")}
          </span>
          <span className="truncate text-[11.5px] text-gray-600 dark:text-white/60" title={current.url}>
            {t("browser.captcha.lead", { agent: current.agentName, site: current.site })}
          </span>
        </div>
      </div>

      <div className="px-4 pt-2">
        <p className="text-[11px] leading-relaxed text-gray-500 dark:text-white/45">
          {t("browser.captcha.hint")}
        </p>
        {others > 0 && (
          <p className="mt-1 text-[10.5px] text-amber-700 dark:text-amber-300/80">
            {t("browser.captcha.more", { count: String(others) })}
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-1.5 px-4 py-3">
        <Button
          variant="custom"
          onClick={() => cancelCaptchaHandoff(current.id)}
          className="cc-t h-7 px-3 rounded-md text-[11.5px] font-medium text-gray-600 dark:text-white/60
            hover:bg-gray-200 dark:hover:bg-white/10 inline-block"
        >
          {t("browser.captcha.cancel")}
        </Button>
        <Button
          variant="primary"
          onClick={() => focusCaptchaView(current, navigate)}
          className="h-7 px-3 text-[11.5px]"
        >
          {t("browser.captcha.solveNow")}
        </Button>
      </div>
    </div>
  );
}
