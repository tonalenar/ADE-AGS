import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { appThemeDeclarations } from "@/features/chat/timeline/isolatedFrame";

import { createMcpAppSession } from "./mcpAppBridge";
import { MCP_APP_SANDBOX, mcpAppSrcdoc } from "./mcpAppDocument";

/** Erro de render do app fica neste quadro. O resto da timeline segue. */
export class McpAppBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return <McpAppFailed />;
    return this.props.children;
  }
}

function McpAppFailed() {
  const { t } = useTranslation();
  return <p role="alert" className="m-0 px-3 py-2 text-chat-note text-gray-700 dark:text-white/70">{t("chat.mcpApp.failed")}</p>;
}

function McpAppLive({ html, onStop }: { html: string; onStop: () => void }) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const stopRef = useRef(onStop);
  stopRef.current = onStop;
  const theme = appThemeDeclarations();
  const srcDoc = useMemo(
    () => mcpAppSrcdoc(html, theme),
    [html, theme.dark, theme.declarations],
  );

  const sessionRef = useRef<ReturnType<typeof createMcpAppSession> | null>(null);
  useEffect(() => {
    const session = createMcpAppSession({
      getFrameWindow: () => frameRef.current?.contentWindow ?? null,
      onStop: () => stopRef.current(),
    });
    sessionRef.current = session;
    return () => {
      sessionRef.current?.close();
      sessionRef.current = null;
    };
  }, []);

  return (
    <iframe
      ref={frameRef}
      title={t("chat.mcpApp.frameTitle")}
      sandbox={MCP_APP_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      className="block h-64 w-full border-0 bg-white dark:bg-surface-deep"
    />
  );
}

/** O app MCP no lugar do resultado. Sem canal de ferramenta, mensagem ou tela cheia. */
export function McpAppFrame({ html }: { html: string }) {
  const { t } = useTranslation();
  const [stopped, setStopped] = useState(false);
  if (stopped) {
    return (
      <p role="status" className="m-0 px-3 py-2 text-chat-note text-gray-700 dark:text-white/70">
        {t("chat.mcpApp.stopped")}
      </p>
    );
  }
  return (
    <McpAppBoundary>
      <McpAppLive html={html} onStop={() => setStopped(true)} />
    </McpAppBoundary>
  );
}
