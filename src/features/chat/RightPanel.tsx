import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { FilesView } from "@/features/explorer/FilesView";
import { DESKTOP_OS } from "@/app/platform";
import { WindowControls } from "@/app/WindowLights";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { comparablePath } from "@/features/tabs/viewTabs";

import { ChevronDownIcon, MaximizeIcon, PanelRightIcon } from "./chatIcons";
import { choosePanel, ENTRY_ICON, onEntryKey, PanelToolbar } from "./PanelToolbar";
import { devicesShare } from "./devicesIpc";
import { sharedDevices } from "./devicesModel";
import { useWorkingDiff } from "./useWorkingDiff";
import { CHAT_SHELL_ATTR, hasTimeline } from "./ConversationView";
import { isAvailable, keyLabel, PANEL_ENTRIES, type PanelAvailability, type PanelChoice } from "./panelMenu";
import type { ConversationCard } from "./chatModel";
import { TeamPanel } from "./team/TeamPanel";
import { clampPanelWidth, PANEL_W, setChatBrowser, setPanelWidth, togglePanelMaximized, toggleRightPanel, useChatStore } from "./store";

// Design e os aparelhos puxam o canvas (`@xyflow/react`): ficam fora do grafo estático do entry.
const DesignPane = lazy(() => import("./DesignPane").then((m) => ({ default: m.DesignPane })));
const IosPane = lazy(() => import("./DevicesPane").then((m) => ({ default: m.IosPane })));
const AndroidPane = lazy(() => import("./DevicesPane").then((m) => ({ default: m.AndroidPane })));


/**
 * O painel direito da prancheta 2: abas no topo (Diff, Arquivos), o conteúdo embaixo. O Diff é o
 * `git diff` de verdade da pasta da conversa, relido quando o agente trabalha.
 */
export function RightPanel({ tabId, cwd, project, conversation = null, cards = [] }: {
  tabId: string | null; cwd: string | null; project: string;
  /** A conversa aberta e os cartões da sidebar, para o painel Time. */
  conversation?: ConversationCard | null; cards?: ConversationCard[];
}) {
  const { t } = useTranslation();
  const panel = useChatStore((s) => s.panel);
  const maximized = useChatStore((s) => s.panelMaximized);
  const panelWidth = useChatStore((s) => s.panelWidth);
  const panelFocus = useChatStore((s) => s.panelFocus);
  const contentRef = useRef<HTMLDivElement>(null);
  useShareDevices();
  // O atalho do Time (e quem mais pedir) leva o foco para dentro do painel.
  useEffect(() => { if (panelFocus > 0) contentRef.current?.focus(); }, [panelFocus]);
  const terminalOn = useChatStore((s) => (tabId ? s.terminalOpen[tabId] ?? false : false));
  // O Resumo não é coluna: flutua ao lado da conversa (`ChatShell`). Aqui só moram as outras superfícies.
  if (!panel || panel === "summary") return null;
  // O terminal é a gaveta da conversa (só as que têm timeline); o PR ainda não tem aba no painel (esmaecido).
  const available: PanelAvailability = { terminal: !!tabId && !!conversation && hasTimeline(conversation.agentId), pr: false };
  const choose = (id: PanelChoice) => choosePanel(id, tabId, terminalOn);
  const empty = panel === "empty";
  const headBtn = "w-7 h-7 flex items-center justify-center rounded-md text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/10";
  // Windows e Linux: os botões da janela moram no canto direito; o conteúdo cede a altura deles. No macOS não há nada a ceder.
  const winControls = DESKTOP_OS === "windows" || DESKTOP_OS === "linux";
  return (
    <aside aria-label={t("chat.panel.label")}
      style={maximized ? undefined : { width: panelWidth }}
      className={`${maximized ? "flex-1" : "shrink"} relative min-w-[360px] h-full flex flex-col border-l border-gray-200 dark:border-white/[0.08] bg-white dark:bg-surface-deep`}>
      {!maximized && <ResizeHandle />}
      {/* Sem faixa de cabeçalho: a fileira de ícones e o recolher moram no cabeçalho principal e cada superfície
          começa no topo da coluna. Fica só uma região de arrasto fina (não cobre os botões da superfície). */}
      <div data-tauri-drag-region aria-hidden="true" className="absolute inset-x-0 top-0 h-2 z-10" />
      {winControls && <div className="absolute top-0 right-0 z-20"><WindowControls /></div>}
      {/* Maximizado, o cabeçalho principal some: a fileira, o restaurar e o recolher vêm para uma barra flutuante discreta. */}
      {maximized && (
        <div className={`absolute right-3 z-20 flex items-center gap-1 rounded-lg bg-white/95 dark:bg-surface-deep/95 p-0.5 shadow-[0_0_0_1px_rgba(24,24,27,0.08),0_8px_24px_-12px_rgba(0,0,0,0.4)] ${winControls ? "top-9" : "top-2"}`}>
          <PanelToolbar tabId={tabId} terminalAvailable={available.terminal} />
          <button type="button" onClick={togglePanelMaximized} aria-pressed aria-label={t("chat.panel.maximize")} title={t("chat.panel.maximize")} className={`${headBtn} bg-gray-100 dark:bg-white/10`}>
            <MaximizeIcon className="w-[15px] h-[15px]" />
          </button>
          <button type="button" onClick={toggleRightPanel} aria-label={t("chat.panel.toggle")} title={t("chat.panel.toggle")} className={headBtn}>
            <PanelRightIcon className="w-[15px] h-[15px]" />
          </button>
        </div>
      )}
      <div ref={contentRef} tabIndex={-1} className={`flex-1 min-h-0 flex flex-col outline-none ${winControls ? "pt-8" : ""}`}>
        {empty && <SurfaceLauncher available={available} onChoose={choose} />}
        {panel === "diff" && <DiffView tabId={tabId} cwd={cwd} />}
        {panel === "files" && cwd && <FilesView cwd={cwd} repo={null} title={project} />}
        {panel === "team" && <TeamPanel conversation={conversation} cards={cards} />}
        {panel === "browser" && cwd && <BrowserSurface cwd={cwd} />}
        {(panel === "design" || panel === "ios" || panel === "android") && (
          <Suspense fallback={<p className="p-4 text-chat-note text-gray-400 dark:text-white/40">{t("chat.panel.loading")}</p>}>
            {panel === "design" ? <DesignPane cwd={cwd} /> : panel === "ios" ? <IosPane /> : <AndroidPane />}
          </Suspense>
        )}
      </div>
    </aside>
  );
}

/**
 * A borda esquerda do painel: arrastar muda a largura (como a divisória do Claude Code); duplo clique
 * volta à padrão. O arrasto segue o ponteiro capturado, então passar por cima do simulador ou do
 * navegador (que são nativos) não o interrompe.
 */
function ResizeHandle() {
  const { t } = useTranslation();
  const [dragging, setDragging] = useState(false);
  // O espaço que painel e conversa dividem: da borda esquerda da conversa (o vizinho do painel; a
  // sidebar de conversas fica de fora) até a direita do painel.
  const room = (el: Element) => {
    const aside = el.closest("aside");
    const main = aside?.previousElementSibling ?? null;
    if (!aside) return null;
    const right = aside.getBoundingClientRect().right;
    const left = main ? main.getBoundingClientRect().left : aside.getBoundingClientRect().left;
    return { right, width: right - left };
  };
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const widthAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = room(e.currentTarget);
    return r ? clampPanelWidth(r.right - e.clientX, r.width) : null;
  };
  return (
    <div role="separator" aria-orientation="vertical" aria-label={t("chat.panel.resize")} title={t("chat.panel.resize")}
      onPointerDown={onDown}
      onPointerMove={(e) => { if (!dragging) return; const w = widthAt(e); if (w !== null) setPanelWidth(w); }}
      onPointerUp={(e) => { if (!dragging) return; setDragging(false); const w = widthAt(e); if (w !== null) setPanelWidth(w, true); }}
      onDoubleClick={(e) => { const r = room(e.currentTarget); setPanelWidth(clampPanelWidth(PANEL_W.initial, r?.width ?? Infinity), true); }}
      className="group absolute -left-[3px] top-0 bottom-0 z-30 w-[6px] cursor-col-resize">
      <span aria-hidden="true" className={`absolute left-[2px] top-0 bottom-0 w-[2px] transition-colors
        ${dragging ? "bg-accent-500" : "bg-transparent group-hover:bg-accent-500/60"}`} />
    </div>
  );
}

/**
 * Os aparelhos abertos no painel chegam aos agentes (`ags device`): o backend os junta aos do canvas.
 * Com a chave do painel desligada, o agente só vê (`shot`/`tree`). Fechar a casca tira todos.
 */
function useShareDevices() {
  const surfaces = useChatStore((s) => s.surfaces);
  const devices = useChatStore((s) => s.devices);
  const names = useChatStore((s) => s.deviceNames);
  const control = useChatStore((s) => s.deviceControl);
  const shared = useMemo(() => sharedDevices(surfaces, devices, names), [surfaces, devices, names]);
  const key = JSON.stringify(shared);
  useEffect(() => { devicesShare(shared, control).catch(() => undefined); }, [key, control]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { devicesShare([], false).catch(() => undefined); }, []);
}

function DiffView({ tabId, cwd }: { tabId: string | null; cwd: string | null }) {
  const { t } = useTranslation();
  const { state, load } = useWorkingDiff(cwd, tabId);

  const total = useMemo(() => state.files.reduce((n, f) => ({ added: n.added + f.added, removed: n.removed + f.removed }), { added: 0, removed: 0 }), [state.files]);

  if (!state.loaded) return <p className="p-4 text-chat-note text-gray-400 dark:text-white/40">{t("chat.panel.loading")}</p>;
  if (!state.repo) return <p className="p-4 text-chat-note text-gray-400 dark:text-white/40">{t("chat.panel.noRepo")}</p>;
  if (state.files.length === 0) return <p className="p-4 text-chat-note text-gray-400 dark:text-white/40">{t("chat.panel.noChanges")}</p>;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 cc-scroll text-chat-caption">
        {state.files.map((file) => (
          <section key={file.path}>
            <div className="sticky top-0 flex items-center gap-2 h-9 px-3 border-b border-gray-200 dark:border-white/[0.08] bg-gray-50 dark:bg-white/[0.03] backdrop-blur">
              <span className="flex-1 truncate font-mono" title={file.path}>{file.path}</span>
              <span className="font-mono"><span className="text-emerald-700 dark:text-emerald-400">+{file.added}</span>{" "}<span className="text-red-700 dark:text-red-400">−{file.removed}</span></span>
            </div>
            <div className="font-mono leading-[1.75]">
              {file.lines.map((line, i) => (
                <div key={i} className={`px-3 whitespace-pre-wrap break-all
                  ${line.kind === "hunk" ? "text-gray-500 dark:text-white/45 bg-gray-100 dark:bg-white/[0.05]"
                    : line.kind === "add" ? "text-emerald-800 dark:text-emerald-300 bg-emerald-500/10"
                      : line.kind === "del" ? "text-red-800 dark:text-red-300 bg-red-500/10" : "text-gray-800 dark:text-white/75"}`}>
                  {line.kind === "add" ? "+" : line.kind === "del" ? "-" : line.kind === "ctx" ? " " : ""}{line.text}
                </div>
              ))}
              {file.lines.length === 0 && <div className="px-3 py-2 text-gray-500 dark:text-white/45">{t("chat.panel.binary")}</div>}
            </div>
          </section>
        ))}
        {state.truncated && <p className="p-3 text-gray-500 dark:text-white/45">{t("chat.panel.truncated")}</p>}
      </div>
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-t border-gray-200 dark:border-white/[0.08] text-chat-note text-gray-500 dark:text-white/45">
        <span className="flex-1">{t("chat.panel.summary", { count: state.files.length, added: total.added, removed: total.removed })}</span>
        <button type="button" onClick={load}
          className="h-7 px-3 rounded-lg border border-gray-200 dark:border-white/10 text-chat-note text-gray-800 dark:text-white/80 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
          {t("chat.panel.refresh")}
        </button>
      </div>
    </div>
  );
}

/**
 * As linhas do menu: ícone, nome e a tecla de atalho numa caixinha à direita; esmaecida a que não se
 * aplica. A tecla vale com o foco na lista (o estado vazio e o menu do "+").
 */
function EntryList({ available, onChoose, active = null }: { available: PanelAvailability; onChoose: (id: PanelChoice) => void; active?: PanelChoice | null }) {
  const { t } = useTranslation();
  return (
    <ul role="menu" className="list-none m-0 p-0 flex flex-col gap-0.5">
      {PANEL_ENTRIES.map((entry) => {
        const Icon = ENTRY_ICON[entry.id];
        const on = isAvailable(entry.id, available);
        return (
          <li key={entry.id} role="none">
            <button type="button" role="menuitem" disabled={!on} aria-disabled={!on} aria-keyshortcuts={keyLabel(entry)}
              onClick={() => onChoose(entry.id)}
              className={`w-full h-9 px-2.5 rounded-lg flex items-center gap-2.5 text-left text-chat-ui
                ${on ? "text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-white/[0.07]" : "text-gray-400 dark:text-white/30 cursor-default"}
                ${active === entry.id ? "bg-gray-100 dark:bg-white/[0.07]" : ""}`}>
              <Icon className="w-4 h-4 shrink-0" />
              <span className="flex-1 truncate">{t(`chat.panel.open.${entry.id}`)}</span>
              {entry.id === "browser" && <ChevronDownIcon className="w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-white/35" />}
              <kbd className="min-w-6 h-6 px-1.5 rounded-md inline-flex items-center justify-center font-sans text-chat-caption
                bg-gray-100 dark:bg-white/[0.07] text-gray-500 dark:text-white/45">{keyLabel(entry)}</kbd>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * O estado vazio do painel (como o T3 Code): "Abrir uma superfície" e a lista com os atalhos. Pega o
 * foco ao aparecer, para as teclas valerem de cara. Some assim que uma superfície se abre.
 */
function SurfaceLauncher({ available, onChoose }: { available: PanelAvailability; onChoose: (id: PanelChoice) => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div ref={ref} tabIndex={0} onKeyDown={(e) => onEntryKey(e, available, onChoose)} aria-label={t("chat.panel.empty.title")}
      className="flex-1 min-h-0 flex items-center justify-center outline-none">
      <div className="w-full max-w-[420px] px-6 pb-24">
        <h2 className="m-0 mb-4 text-center text-chat-ui font-medium text-gray-900 dark:text-white">{t("chat.panel.empty.title")}</h2>
        <EntryList available={available} onChoose={onChoose} />
      </div>
    </div>
  );
}

/**
 * A aba Navegador: o navegador do ADE (o mesmo das abas e do canvas) para a pasta da conversa. Como o
 * terminal, ele não é montado aqui: esta tela reserva o espaço e publica, e o `ViewTabsHost` o
 * desenha por cima. Reaproveita o navegador que a pasta já tiver; senão abre um.
 */
function BrowserSurface({ cwd }: { cwd: string }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const existing = useViewTabsStore((s) =>
    s.views.find((v) => v.kind === "browser" && !v.owner && comparablePath(v.cwd) === comparablePath(cwd))?.id ?? null);
  const [viewId, setViewId] = useState<string | null>(existing);

  useEffect(() => {
    if (existing) setViewId(existing);
    else setViewId(useViewTabsStore.getState().openBrowser(cwd, "", { activate: false }));
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps -- um navegador por pasta, criado uma vez

  const measure = useCallback(() => {
    const el = slotRef.current;
    const base = el?.closest(`[${CHAT_SHELL_ATTR}]`);
    if (!el || !base || !viewId) return setChatBrowser(null);
    const r = el.getBoundingClientRect();
    const b = base.getBoundingClientRect();
    setChatBrowser({ viewId, rect: { left: Math.round(r.left - b.left), top: Math.round(r.top - b.top), width: Math.round(r.width), height: Math.round(r.height) } });
  }, [viewId]);

  useLayoutEffect(() => measure());
  useEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    const base = el.closest(`[${CHAT_SHELL_ATTR}]`);
    if (base) observer.observe(base);
    return () => observer.disconnect();
  }, [measure]);
  useEffect(() => () => setChatBrowser(null), []);

  return <div ref={slotRef} className="flex-1 min-h-0" />;
}
