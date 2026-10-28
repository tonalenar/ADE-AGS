import { useEffect, useRef, useState } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import { useTranslation } from "react-i18next";

import { SendIcon } from "@/app/icons";
import { highlightAgents } from "@/features/browser/agentHighlight";
import { agentPaint } from "@/features/browser/agentPaint";
import { useUnreadStore } from "@/features/canvas/chatUnread";
import { boardKeyOfTab, useCanvasStore } from "@/features/canvas/store";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID, type Tab } from "@/features/tabs/types";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { showBotToast } from "@/shared/brand/botToastStore";
import { ContextMenu, type ContextMenuItem } from "@/shared/ui/ContextMenu";

import {
  buildExcerpt,
  destinationLabel,
  EXCERPT_MAX_BYTES,
  EXCERPT_MAX_LINES,
  excerptPillPosition,
  PILL,
  selectionLines,
  type Excerpt,
  type Translate,
} from "./terminalExcerpt";
import { focusTab, insertIntoTab } from "./terminalRegistry";

/** Quanto a seleção tem de ficar parada para o botão aparecer: durante o arrasto ele não fica pulando. */
const SETTLE_MS = 120;

/** Onde vai o botão, em pixels da caixa do terminal (sem a escala do canvas). `null` sem seleção visível. */
function pillPlace(term: XTerm, host: HTMLElement): { left: number; top: number } | null {
  const sel = term.getSelectionPosition();
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  if (!sel || !screen || !term.getSelection().trim() || term.rows === 0 || term.cols === 0) return null;
  const hostRect = host.getBoundingClientRect();
  // No canvas alejado a caixa é desenhada com `transform: scale` (ver `scaledMouse.ts`): os retângulos vêm
  // em pixels de tela e o botão é posicionado em pixels da caixa.
  const scale = host.offsetWidth > 0 ? hostRect.width / host.offsetWidth : 1;
  const screenRect = screen.getBoundingClientRect();
  const top = term.buffer.active.viewportY;
  let endRow = sel.end.y;
  let endCol = sel.end.x;
  if (endRow > sel.start.y && endCol === 0) {
    endRow -= 1;
    endCol = term.cols;
  }
  return excerptPillPosition({
    startRow: sel.start.y - top,
    endRow: endRow - top,
    endCol,
    rows: term.rows,
    cols: term.cols,
    cell: { width: screen.offsetWidth / term.cols, height: screen.offsetHeight / term.rows },
    origin: { left: (screenRect.left - hostRect.left) / scale, top: (screenRect.top - hostRect.top) / scale },
    box: { width: host.offsetWidth, height: host.offsetHeight },
  });
}

/**
 * "Enviar trecho…": com texto selecionado no terminal, um botão perto da seleção (e o clique direito) leva o
 * trecho, com a origem e as linhas, para a entrada de outro agente (sem Enter) ou para o rascunho do chat
 * desta aba. Nada é enviado sozinho: a pessoa completa com a pergunta e manda.
 */
export function ExcerptAction({ tabId, term, host }: { tabId: string; term: XTerm; host: HTMLElement }) {
  const { t } = useTranslation();
  const tr: Translate = (key, options) => String(t(key, options));
  const [pill, setPill] = useState<{ left: number; top: number } | null>(null);
  const [context, setContext] = useState<{ x: number; y: number; excerpt: Excerpt } | null>(null);
  const [send, setSend] = useState<{ x: number; y: number; excerpt: Excerpt } | null>(null);
  /** Onde o ponteiro desceu de verdade: o `contextmenu` que chega aqui pode ser a cópia do `scaledMouse`,
   *  com a coordenada desfeita da escala, e o menu tem de abrir onde a pessoa clicou. */
  const pointer = useRef({ x: 0, y: 0 });

  useEffect(() => {
    let timer: number | undefined;
    let frame = 0;
    const place = () => {
      const next = pillPlace(term, host);
      setPill((prev) => (prev && next && prev.left === next.left && prev.top === next.top ? prev : next));
    };
    const later = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(place, SETTLE_MS);
    };
    // A saída de um agente rola a tela a cada linha: uma medida por quadro basta.
    const onScroll = () => {
      if (frame || !term.hasSelection()) return;
      frame = requestAnimationFrame(() => { frame = 0; place(); });
    };
    const subs = [term.onSelectionChange(later), term.onScroll(onScroll), term.onResize(later)];
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      subs.forEach((sub) => sub.dispose());
    };
  }, [term, host]);

  // A seleção de agora, já como o bloco que vai ser colado. Tirada ao abrir o menu: clicar fora pode limpá-la.
  const snapshot = (): Excerpt | null => {
    const sel = term.getSelectionPosition();
    const text = term.getSelection();
    if (!sel || !text.trim()) return null;
    const buf = term.buffer.active;
    const { from, to } = selectionLines(sel, (y) => buf.getLine(y)?.translateToString(true) ?? "");
    const source = useTabsStore.getState().tabs.find((tab) => tab.id === tabId)?.title ?? tabId;
    return buildExcerpt({ source, text, from, to }, tr);
  };

  useEffect(() => {
    const onDown = (e: PointerEvent) => { pointer.current = { x: e.clientX, y: e.clientY }; };
    const onMenu = (e: MouseEvent) => {
      if (!term.hasSelection()) return;
      const excerpt = snapshot();
      if (!excerpt) return;
      e.preventDefault();
      setContext({ ...pointer.current, excerpt });
    };
    host.addEventListener("pointerdown", onDown, true);
    host.addEventListener("contextmenu", onMenu);
    return () => {
      host.removeEventListener("pointerdown", onDown, true);
      host.removeEventListener("contextmenu", onMenu);
    };
    // `snapshot` lê tudo na hora (store e xterm): não precisa reinstalar a cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, host]);

  // Com a lista aberta, cada aba de agente fica da cor da sua linha (como no "Enviar a" dos arquivos).
  useEffect(() => {
    if (!send) return;
    highlightAgents(useTabsStore.getState().tabs.filter((tab) => tab.id !== tabId && tab.agentId !== SHELL_AGENT_ID).map((tab) => tab.id));
    return () => highlightAgents([]);
  }, [send, tabId]);

  const toast = (text: string, tone?: "warning" | "error") =>
    showBotToast({ title: tr("terminal.excerpt.title"), text, tone, ms: tone ? 6000 : 4000 });
  const cutNote = (excerpt: Excerpt) =>
    excerpt.truncated ? ` ${tr("terminal.excerpt.cut", { lines: EXCERPT_MAX_LINES, kb: Math.round(EXCERPT_MAX_BYTES / 1024) })}` : "";

  const toAgent = (tab: Tab, excerpt: Excerpt) => {
    // A quebra no fim: a pergunta começa numa linha nova, fora do bloco de código.
    const result = insertIntoTab(tab.id, `${excerpt.text}\n`);
    if (result === "offline") return toast(tr("terminal.excerpt.offline", { name: tab.title }), "warning");
    if (result === "no-multiline") {
      void navigator.clipboard.writeText(excerpt.text).catch(console.error);
      return toast(tr("terminal.excerpt.noMultiline", { name: tab.title }), "warning");
    }
    useTabsStore.getState().activateTab(tab.id);
    useViewTabsStore.getState().showTerminal();
    requestAnimationFrame(() => focusTab(tab.id));
    toast(tr("terminal.excerpt.pasted", { name: tab.title }) + cutNote(excerpt));
  };

  const toChat = (excerpt: Excerpt) => {
    // O chat vive no canvas: o pedido abre o painel nesta aba (e passa ao canvas, como o clique num aviso).
    useTabsStore.getState().activateTab(tabId);
    useUnreadStore.getState().setJump({ tabId, thread: "", text: excerpt.text });
    if (excerpt.truncated) toast(cutNote(excerpt).trim());
  };

  const destinations = (excerpt: Excerpt): ContextMenuItem[] => {
    const tabs = useTabsStore.getState().tabs;
    const source = tabs.find((tab) => tab.id === tabId);
    const items: ContextMenuItem[] = [];
    if (source && source.agentId !== SHELL_AGENT_ID) {
      const { boards, modes } = useCanvasStore.getState();
      const inCanvas = modes[boardKeyOfTab(source, boards)] === "canvas";
      items.push({ key: "chat", label: tr(inCanvas ? "terminal.excerpt.chat" : "terminal.excerpt.chatCanvas"), onSelect: () => toChat(excerpt) });
    }
    const others = tabs.filter((tab) => tab.id !== tabId && tab.agentId !== SHELL_AGENT_ID);
    if (others.length === 0) {
      items.push({ key: "none", label: tr("terminal.excerpt.noAgents"), disabled: true, separator: items.length > 0, onSelect: () => undefined });
    }
    others.forEach((tab, i) => items.push({
      key: tab.id,
      label: destinationLabel(tab),
      icon: <span className={`m-auto w-2.5 h-2.5 rounded-full ${agentPaint(tab.id).strip}`} />,
      separator: i === 0 && items.length > 0,
      onSelect: () => toAgent(tab, excerpt),
    }));
    return items;
  };

  const openSend = (x: number, y: number) => {
    const excerpt = snapshot();
    if (!excerpt) return toast(tr("terminal.excerpt.empty"), "warning");
    setSend({ x, y, excerpt });
  };

  return (
    <>
      {pill && (
        <button
          type="button"
          title={t("terminal.excerpt.actionHint")}
          aria-label={t("terminal.excerpt.actionHint")}
          // Sem tirar o foco do terminal (e sem o xterm ver o clique: o botão está fora da tela dele).
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openSend(r.left, r.bottom + 2);
          }}
          style={{ position: "absolute", left: pill.left, top: pill.top, height: PILL.height, maxWidth: PILL.width, zIndex: 5 }}
          className="cc-t flex items-center gap-1.5 rounded-full border border-white/15 bg-gray-950/90 px-2.5 text-[11px] font-medium text-white shadow-lg backdrop-blur-sm hover:bg-accent-500 dark:bg-surface-raised/95"
        >
          <SendIcon className="h-3 w-3 shrink-0" />
          <span className="truncate">{t("terminal.excerpt.action")}</span>
        </button>
      )}
      {context && (
        <ContextMenu x={context.x} y={context.y} onClose={() => setContext(null)} items={[
          { key: "copy", label: tr("terminal.excerpt.copy"), hint: "Ctrl+C", onSelect: () => { void navigator.clipboard.writeText(term.getSelection()).catch(console.error); } },
          { key: "send", label: tr("terminal.excerpt.action"), icon: <SendIcon className="w-3.5 h-3.5" />, onSelect: () => setSend({ x: context.x, y: context.y, excerpt: context.excerpt }) },
        ]} />
      )}
      {send && <ContextMenu x={send.x} y={send.y} onClose={() => setSend(null)} items={destinations(send.excerpt)} />}
    </>
  );
}
