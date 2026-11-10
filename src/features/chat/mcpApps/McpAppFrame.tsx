import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useAskStore } from "@/features/ask/askStore";
import { activeComposerCommandTarget } from "@/features/chat/composerCommands";
import { insertIntoComposer } from "@/features/chat/store";
import { appThemeDeclarations } from "@/features/chat/timeline/isolatedFrame";

import { McpAppApprovalDialog } from "./McpAppApprovalDialog";
import { createMcpAppSession } from "./mcpAppBridge";
import { MCP_APP_SANDBOX, mcpAppSrcdoc } from "./mcpAppDocument";
import { createFullscreenGuard } from "./mcpAppFullscreen";
import {
  createMcpAppHandlers,
  type McpAppApprovalAnswer,
  type McpAppApprovalRequest,
  type McpAppToolHost,
} from "./mcpAppHandlers";

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

interface PendingApproval {
  request: McpAppApprovalRequest;
  settle: (answer: McpAppApprovalAnswer) => void;
}

export interface McpAppFrameProps {
  html: string;
  /** O servidor dono do app, para o diálogo de aprovação. */
  server?: string;
  /**
   * Executa ferramentas do servidor do app. A ADE não tem um cliente MCP do lado do host, então a timeline não
   * passa isto e `tools/call` segue recusado. Com ele, a aprovação vale para toda ferramenta não somente leitura.
   */
  toolHost?: McpAppToolHost;
  /** Põe a mensagem aprovada do app no composer. O padrão usa o composer da conversa visível. Nunca envia. */
  postToComposer?: (text: string, target: string | null) => void;
}

const defaultPostToComposer = (text: string, target: string | null) => insertIntoComposer(text, target);

function McpAppLive({ html, server = "?", toolHost, postToComposer = defaultPostToComposer, onStop }: McpAppFrameProps & { onStop: () => void }) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const stopRef = useRef(onStop);
  stopRef.current = onStop;
  const postRef = useRef(postToComposer);
  postRef.current = postToComposer;
  const theme = appThemeDeclarations();
  const srcDoc = useMemo(
    () => mcpAppSrcdoc(html, theme),
    [html, theme.dark, theme.declarations],
  );

  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenRef = useRef(false);
  const setMode = (next: boolean) => {
    fullscreenRef.current = next;
    setFullscreen(next);
  };
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const pendingRef = useRef<PendingApproval | null>(null);
  const targetRef = useRef<string | null>(null);
  const guard = useMemo(() => createFullscreenGuard(), []);
  // Outro diálogo da ADE esperando a pessoa (uma pergunta de agente, por exemplo) também devolve o app à conversa.
  const asking = useAskStore((s) => s.questions.length > 0);

  // Aprovação pendente (deste app) ou de outro lugar: a tela cheia não fica por cima do que pede atenção.
  useEffect(() => {
    if (asking) setMode(false);
  }, [asking]);

  // Qualquer clique ou tecla fora do app entra na regra dos 5 s; Escape fora do app devolve o app à conversa.
  // Teclas e cliques DENTRO do iframe não chegam aqui: é por isso que o Escape do app não sai da tela cheia.
  useEffect(() => {
    const onPointer = () => guard.outside();
    const onKey = (event: KeyboardEvent) => {
      guard.outside();
      if (event.key === "Escape" && fullscreenRef.current) setMode(false);
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [guard]);

  useEffect(() => {
    const requestApproval = (request: McpAppApprovalRequest) => new Promise<McpAppApprovalAnswer>((resolve) => {
      if (pendingRef.current) {
        resolve("busy");
        return;
      }
      if (request.kind === "message") targetRef.current = activeComposerCommandTarget();
      const entry: PendingApproval = {
        request,
        settle: (answer) => {
          if (pendingRef.current !== entry) return;
          pendingRef.current = null;
          setPending(null);
          resolve(answer);
        },
      };
      pendingRef.current = entry;
      setPending(entry);
      setMode(false);
    });
    const session = createMcpAppSession({
      getFrameWindow: () => frameRef.current?.contentWindow ?? null,
      onStop: () => stopRef.current(),
      // O app avisa o clique, mas pode mentir: só vale com o quadro em foco, e o foco só vai para lá por clique da pessoa.
      onGesture: () => {
        if (frameRef.current && document.activeElement === frameRef.current) guard.gesture();
      },
      handlers: createMcpAppHandlers({
        server,
        toolHost,
        requestApproval,
        postToComposer: (text) => postRef.current(text, targetRef.current),
        enterFullscreen: () => {
          if (fullscreenRef.current) return true;
          if (pendingRef.current || useAskStore.getState().questions.length > 0) return false;
          if (!guard.consume()) return false;
          setMode(true);
          return true;
        },
        exitFullscreen: () => setMode(false),
      }),
    });
    return () => {
      session.close();
      // Sem o quadro, quem espera aprovação recebe negado.
      pendingRef.current?.settle("denied");
    };
    // O servidor e o executor de ferramentas são fixos por linha de ferramenta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guard]);

  return (
    <div className="relative h-64 w-full">
      <div className={fullscreen ? "fixed inset-0 z-[90] bg-white dark:bg-surface-deep" : "h-full w-full"}>
        {fullscreen && (
          <button type="button" onClick={() => setMode(false)}
            className="absolute right-3 top-3 z-10 rounded-md px-2.5 py-1 text-chat-note font-medium text-gray-900 dark:text-white
              bg-white/90 dark:bg-surface-deep/90 border border-gray-200 dark:border-white/15 shadow hover:bg-gray-100 dark:hover:bg-white/10
              focus-visible:ring-2 focus-visible:ring-accent-500/50">
            {t("chat.mcpApp.exitFullscreen")}
          </button>
        )}
        {/* O mesmo iframe nos dois modos: só a classe do pai muda. Trocar o pai recarregaria o app. */}
        <iframe
          ref={frameRef}
          title={t("chat.mcpApp.frameTitle")}
          sandbox={MCP_APP_SANDBOX}
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          className="block h-full w-full border-0 bg-white dark:bg-surface-deep"
        />
      </div>
      {pending && <McpAppApprovalDialog request={pending.request} onDecide={(allowed) => pending.settle(allowed ? "approved" : "denied")} />}
    </div>
  );
}

/** O app MCP no lugar do resultado. Mensagem e ferramenta só com a sua aprovação; tela cheia só depois de um clique. */
export function McpAppFrame(props: McpAppFrameProps) {
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
      <McpAppLive {...props} onStop={() => setStopped(true)} />
    </McpAppBoundary>
  );
}
