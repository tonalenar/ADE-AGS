import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { FilesView } from "@/features/explorer/FilesView";
import { WindowControls } from "@/app/WindowLights";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { comparablePath, type ViewTab } from "@/features/tabs/viewTabs";

import { ChevronDownIcon, DesignIcon, DetailsIcon, DiffIcon, FilesIcon, GlobeIcon, MaximizeIcon, PanelBottomIcon, PanelRightIcon, PhoneIcon, PlusIcon, PullRequestIcon, TerminalIcon, UsersIcon, XIcon } from "./chatIcons";
import { devicesShare } from "./devicesIpc";
import { sharedDevices } from "./devicesModel";
import { useWorkingDiff } from "./useWorkingDiff";
import { CHAT_SHELL_ATTR, hasTimeline, useTerminalOpen } from "./ConversationView";
import { entryForKey, isAvailable, keyLabel, PANEL_ENTRIES, type PanelAvailability, type PanelChoice } from "./panelMenu";
import type { ConversationCard } from "./chatModel";
import { SummaryPane } from "./summary/SummaryPane";
import { TeamPanel } from "./team/TeamPanel";
import { addSurface, clampPanelWidth, hostLabel, PANEL_W, removeSurface, setChatBrowser, setPanelWidth, setRightPanel, setTerminalOpen, togglePanelMaximized, toggleRightPanel, useChatStore, type Surface } from "./store";
import { usePopover } from "./usePopover";

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
  const surfaces = useChatStore((s) => s.surfaces);
  // As abas levam o nome do que mostram (prancheta 8): o endereço do navegador, o aparelho ligado.
  const browserUrl = useViewTabsStore((s) =>
    cwd ? s.views.find((v): v is Extract<ViewTab, { kind: "browser" }> => v.kind === "browser" && !v.owner && comparablePath(v.cwd) === comparablePath(cwd))?.url ?? null : null);
  const deviceNames = useChatStore((s) => s.deviceNames);
  const panelWidth = useChatStore((s) => s.panelWidth);
  const panelFocus = useChatStore((s) => s.panelFocus);
  const contentRef = useRef<HTMLDivElement>(null);
  useShareDevices();
  // O atalho do Time (e quem mais pedir) leva o foco para dentro do painel.
  useEffect(() => { if (panelFocus > 0) contentRef.current?.focus(); }, [panelFocus]);
  if (!panel) return null;
  // O terminal é a gaveta da conversa (só as que têm timeline); o PR ainda não tem aba no painel (esmaecido).
  const available: PanelAvailability = { terminal: !!tabId && !!conversation && hasTimeline(conversation.agentId), pr: false };
  const choose = (id: PanelChoice) => {
    if (id === "summary") setRightPanel("summary");
    else if (id === "diff") setRightPanel("diff");
    else if (id === "terminal") { if (tabId) setTerminalOpen(tabId, true); }
    else if (id !== "pr") addSurface(id);
  };
  const empty = panel === "empty";
  const label = (surface: Surface) =>
    surface === "browser" ? hostLabel(browserUrl) ?? t("chat.panel.browser")
    : surface === "ios" || surface === "android" ? deviceNames[surface] ?? t(`chat.panel.${surface}`)
    : t(`chat.panel.${surface}`);
  const icon = (surface: Surface) => (surface === "browser" ? <GlobeIcon className="w-3 h-3 shrink-0" /> : null);
  const headBtn = "w-7 h-7 flex items-center justify-center rounded-md text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/10";
  const tabCls = (on: boolean) => `h-6 max-w-40 px-2 rounded-md text-chat-caption inline-flex items-center gap-1.5
    ${on ? "bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-white font-medium" : "text-gray-500 dark:text-white/45 hover:bg-gray-100/60 dark:hover:bg-white/[0.06]"}`;
  return (
    <aside aria-label={t("chat.panel.label")}
      style={maximized ? undefined : { width: panelWidth }}
      className={`${maximized ? "flex-1" : "shrink"} relative min-w-[360px] h-full flex flex-col border-l border-gray-200 dark:border-white/[0.08] bg-white dark:bg-surface-deep`}>
      {!maximized && <ResizeHandle />}
      <div role="tablist" data-tauri-drag-region className="h-[52px] shrink-0 flex items-center gap-1 pl-2 pr-3">
        {/* No estado vazio não há aba nenhuma, só o "+" (como no T3). */}
        {!empty && (
          <button type="button" role="tab" aria-selected={panel === "summary"} onClick={() => setRightPanel("summary")} className={tabCls(panel === "summary")}>
            {t("chat.panel.summaryTab")}
          </button>
        )}
        {!empty && (
          <button type="button" role="tab" aria-selected={panel === "diff"} onClick={() => setRightPanel("diff")} className={tabCls(panel === "diff")}>
            {t("chat.panel.diff")}
          </button>
        )}
        {!empty && surfaces.map((surface) => (
          <span key={surface} className="group relative inline-flex">
            <button type="button" role="tab" aria-selected={panel === surface} onClick={() => setRightPanel(surface)} className={tabCls(panel === surface)}>
              {icon(surface)}<span className="truncate">{label(surface)}</span>
            </button>
            <button type="button" onClick={() => removeSurface(surface)} aria-label={t("chat.panel.close", { name: label(surface) })}
              className="hidden group-hover:flex absolute -right-1 -top-1 w-3.5 h-3.5 items-center justify-center rounded-full bg-gray-300 dark:bg-white/25 text-gray-700 dark:text-white">
              <XIcon className="w-2.5 h-2.5" />
            </button>
          </span>
        ))}
        <AddSurface available={available} onChoose={choose} />
        <span data-tauri-drag-region className="flex-1 self-stretch" />
        <button type="button" onClick={togglePanelMaximized} aria-pressed={maximized} aria-label={t("chat.panel.maximize")} title={t("chat.panel.maximize")}
          className={headBtn}>
          <MaximizeIcon className="w-[15px] h-[15px]" />
        </button>
        <PanelTerminalToggle conversation={available.terminal ? conversation : null} />
        <button type="button" onClick={toggleRightPanel} aria-pressed aria-label={t("chat.panel.toggle")} title={t("chat.panel.toggle")}
          className={`${headBtn} bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-white`}>
          <PanelRightIcon className="w-[15px] h-[15px]" />
        </button>
        <WindowControls className="-mr-3" />
      </div>
      <div ref={contentRef} tabIndex={-1} className="flex-1 min-h-0 flex flex-col border-t border-gray-200 dark:border-white/[0.08] outline-none">
        {empty && <SurfaceLauncher available={available} onChoose={choose} />}
        {panel === "summary" && <SummaryPane conversation={conversation} cwd={cwd} tabId={tabId} />}
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

/** Os ícones das linhas do menu "Abrir uma superfície". */
const ENTRY_ICON: Record<PanelChoice, (p: { className?: string }) => React.ReactElement> = {
  summary: DetailsIcon, browser: GlobeIcon, terminal: TerminalIcon, files: FilesIcon, diff: DiffIcon, design: DesignIcon,
  ios: PhoneIcon, android: PhoneIcon, team: UsersIcon, pr: PullRequestIcon,
};

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

/** Uma tecla do menu abre a linha dela (as esmaecidas e as com modificador não). */
function onEntryKey(e: React.KeyboardEvent, available: PanelAvailability, onChoose: (id: PanelChoice) => void): void {
  const entry = entryForKey(e, available);
  if (!entry) return;
  e.preventDefault();
  e.stopPropagation();
  onChoose(entry.id);
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

/** O "+" do painel: o mesmo menu do estado vazio (Navegador, Terminal, Arquivos, Diff, Design, aparelhos, Time e PR). */
function AddSurface({ available, onChoose }: { available: PanelAvailability; onChoose: (id: PanelChoice) => void }) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const pick = (id: PanelChoice) => { onChoose(id); setOpen(false); };
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} aria-label={t("chat.panel.add")} title={t("chat.panel.add")} aria-expanded={open}
        className="w-6 h-6 flex items-center justify-center rounded-md text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/10">
        <PlusIcon className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div onKeyDown={(e) => onEntryKey(e, available, pick)} ref={(el) => el?.focus()} tabIndex={-1}
          className="absolute left-0 top-full mt-1 z-50 w-[260px] p-1 rounded-lg bg-white dark:bg-surface-raised outline-none
          shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_16px_40px_-18px_rgba(0,0,0,0.55)]">
          <EntryList available={available} onChoose={pick} />
        </div>
      )}
    </div>
  );
}

/** O botão do terminal no canto do painel (como no T3): abre e fecha a gaveta da conversa. Esmaecido sem gaveta. */
function PanelTerminalToggle({ conversation }: { conversation: ConversationCard | null }) {
  const { t } = useTranslation();
  const cls = "w-7 h-7 flex items-center justify-center rounded-md";
  if (!conversation) {
    return <button type="button" disabled aria-label={t("chat.terminal.toggle")} title={t("chat.terminal.toggle")} className={`${cls} text-gray-500 dark:text-white/45 opacity-40`}><PanelBottomIcon className="w-[15px] h-[15px]" /></button>;
  }
  return <TerminalToggleOn conversation={conversation} className={cls} />;
}

function TerminalToggleOn({ conversation, className }: { conversation: ConversationCard; className: string }) {
  const { t } = useTranslation();
  const open = useTerminalOpen(conversation);
  return (
    <button type="button" onClick={() => setTerminalOpen(conversation.tabId, !open)} aria-pressed={open} aria-label={t("chat.terminal.toggle")} title={t("chat.terminal.toggle")}
      className={`${className} ${open ? "bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-white" : "text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/10"}`}>
      <PanelBottomIcon className="w-[15px] h-[15px]" />
    </button>
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
