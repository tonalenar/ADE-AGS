import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { FilesView } from "@/features/explorer/FilesView";
import { SelectionComment } from "@/features/chat/quotes/SelectionComment";
import { DESKTOP_OS } from "@/app/platform";
import { WindowControls } from "@/app/WindowLights";
import { useTabsStore } from "@/features/tabs/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { comparablePath, type BrowserView, type ViewOwner, type ViewTab } from "@/features/tabs/viewTabs";
import { scmWorkingFiles } from "@/features/scm/ipc";
import type { WorkingFiles } from "@/features/scm/types";

import { ColumnTabBar, openSurface } from "./ColumnTabBar";
import { browserScope, pickResource, shellScope, type ColumnTab } from "./columnTabs";
import { SurfaceLauncher } from "./SurfaceMenu";
import { devicesShare } from "./devicesIpc";
import { sharedDevices } from "./devicesModel";
import { useWorkingDiff } from "./useWorkingDiff";
import { claimShellTab } from "./shellTerminal";
import { CHAT_SHELL_ATTR } from "./ConversationView";
import type { PanelAvailability } from "./panelMenu";
import { hasTimeline, type ConversationCard } from "./chatModel";
import { TeamPanel } from "./team/TeamPanel";
import { SideChatPanel } from "./SideChatPanel";
import { PROTOCOL_AGENTS } from "./chatModel";
import { TasksPanel } from "./tasks/TasksPanel";
import { clampPanelWidth, PANEL_W, setChatBrowser, setChatShell, setColumnTabResource, setPanelWidth, useChatStore } from "./store";

// Design e os aparelhos puxam o canvas (`@xyflow/react`): ficam fora do grafo estático do entry.
const DesignPane = lazy(() => import("./DesignPane").then((m) => ({ default: m.DesignPane })));
const IosPane = lazy(() => import("./DevicesPane").then((m) => ({ default: m.IosPane })));
const AndroidPane = lazy(() => import("./DevicesPane").then((m) => ({ default: m.AndroidPane })));
const PullRequestPane = lazy(() => import("./PullRequestPane").then((m) => ({ default: m.PullRequestPane })));

const DIFF_FIND_MAX_RESULTS = 500;

interface DiffFindResult {
  id: string;
  path: string;
  line: number | null;
  text: string;
  from: number;
  to: number;
}


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
  // A aba à vista: o `panel` é a superfície dela (o `reconcileColumn` garante que existe uma aba para ele).
  const activeTab = useChatStore((s) => s.columnTabs.find((tab) => tab.id === s.columnActive && tab.kind === s.panel) ?? null);
  const contentRef = useRef<HTMLDivElement>(null);
  useShareDevices();
  // O atalho do Time (e quem mais pedir) leva o foco para dentro do painel.
  useEffect(() => { if (panelFocus > 0) contentRef.current?.focus(); }, [panelFocus]);
  // A gaveta do agente: só a conversa de TUI com timeline. As outras abrem a aba Terminal (um shell na pasta).
  const drawerTabId = tabId && conversation && hasTimeline(conversation.agentId) ? tabId : null;
  const composerTarget = conversation?.tabId ?? tabId ?? "new-conversation";
  if (!panel) return null;
  // O painel de PR depende de uma pasta de repositório.
  const available: PanelAvailability = { terminal: !!conversation && !!cwd, pr: !!cwd, side: !!conversation && (!!PROTOCOL_AGENTS[conversation.agentId] || conversation.agentId.startsWith("local-acp-")) };
  const empty = panel === "empty";
  const owner = browserOwnerOf(conversation);
  // Windows e Linux: os botões da janela moram no canto direito da barra, que cede o lugar deles. No macOS não há nada a ceder.
  const winControls = DESKTOP_OS === "windows" || DESKTOP_OS === "linux";
  return (
    <aside aria-label={t("chat.panel.label")}
      style={maximized ? undefined : { width: panelWidth }}
      // A coluna encolhe até 280 px: numa janela de ~1000 px, sidebar, conversa (440 px no mínimo, com o cabeçalho
      // inteiro) e painel cabem sem nada passar da borda da janela (com 360 px, o terminal e o simulador eram cortados).
      className={`${maximized ? "flex-1" : "shrink"} relative min-w-[280px] h-full flex flex-col border-l border-gray-200 dark:border-white/[0.08] bg-white dark:bg-surface-deep`}>
      {!maximized && <ResizeHandle />}
      {winControls && <div className="absolute top-0 right-0 z-20"><WindowControls /></div>}
      {/* A barra de abas da coluna (como a do T3 Code): abas, "+", expandir, painel inferior e recolher. */}
      <ColumnTabBar available={available} drawerTabId={drawerTabId} reserveWindowControls={winControls}
        scopes={{ browser: browserScope(cwd ?? "", owner), shell: shellScope(cwd ?? "") }} />
      <div ref={contentRef} tabIndex={-1} className="flex-1 min-h-0 flex flex-col outline-none">
        {empty && <SurfaceLauncher available={available} onPick={openSurface} />}
        {panel === "diff" && <DiffView tabId={tabId} cwd={cwd} />}
        {/* O terminal e o navegador não são montados aqui: cada aba só reserva o espaço e publica o retângulo, e o
            `TerminalPanel`/`ViewTabsHost` desenham o PTY/a página por cima. Trocar de aba troca quem publica; nada desmonta. */}
        {panel === "shell" && cwd && activeTab && <ShellSurface cwd={cwd} tab={activeTab} />}
        {panel === "files" && cwd && <FilesView cwd={cwd} repo={null} title={project} />}
        {panel === "team" && <TeamPanel conversation={conversation} cards={cards} />}
        {panel === "side" && <SideChatPanel conversation={conversation} cards={cards} />}
        {panel === "tasks" && <TasksPanel conversation={conversation} />}
        {panel === "pr" && cwd && <Suspense fallback={<p className="p-4 text-chat-note text-gray-400 dark:text-white/40">{t("chat.panel.loading")}</p>}><PullRequestPane key={`${cwd}:${conversation?.branch ?? ""}`} cwd={cwd} branch={conversation?.branch ?? null} quoteKey={conversation?.tabId ?? null} /></Suspense>}
        {panel === "browser" && activeTab && <BrowserSurface cwd={cwd ?? ""} owner={owner} tab={activeTab} />}
        {(panel === "design" || panel === "ios" || panel === "android") && (
          <Suspense fallback={<p className="p-4 text-chat-note text-gray-400 dark:text-white/40">{t("chat.panel.loading")}</p>}>
            {panel === "design" ? <DesignPane cwd={cwd} composerTarget={composerTarget} /> : panel === "ios" ? <IosPane composerTarget={composerTarget} /> : <AndroidPane composerTarget={composerTarget} />}
          </Suspense>
        )}
      </div>
      {panel === "diff" && (conversation?.tabId ?? tabId) && <SelectionComment container={() => contentRef.current} quoteKey={conversation?.tabId ?? tabId!} />}
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
  const rootRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const resultTargets = useRef(new Map<string, HTMLElement>());
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const [workingFiles, setWorkingFiles] = useState<WorkingFiles | null>(null);
  const [workingFilesLoading, setWorkingFilesLoading] = useState(false);
  const [workingFilesFailed, setWorkingFilesFailed] = useState(false);
  const hasFindQuery = Boolean(findQuery.trim());

  useEffect(() => {
    if (!findOpen || !hasFindQuery || !cwd) return;
    let current = true;
    setWorkingFilesLoading(true);
    setWorkingFiles(null);
    setWorkingFilesFailed(false);
    scmWorkingFiles(cwd)
      .then((files) => { if (current) { setWorkingFiles(files); setWorkingFilesFailed(files === null); } })
      .catch(() => { if (current) { setWorkingFiles(null); setWorkingFilesFailed(true); } })
      .finally(() => { if (current) setWorkingFilesLoading(false); });
    return () => { current = false; };
  }, [cwd, findOpen, hasFindQuery, state.files]);

  const findMatches = useMemo(() => {
    const query = findQuery.trim().toLocaleLowerCase();
    if (!query) return { results: [] as DiffFindResult[], truncated: false };
    const results: DiffFindResult[] = [];
    let truncated = false;
    const collect = (text: string, path: string, line: number | null) => {
      if (results.length >= DIFF_FIND_MAX_RESULTS) { truncated = true; return; }
      const normalized = text.toLocaleLowerCase();
      for (let from = normalized.indexOf(query); from >= 0; from = normalized.indexOf(query, from + Math.max(1, query.length))) {
        if (results.length >= DIFF_FIND_MAX_RESULTS) { truncated = true; return; }
        const to = from + query.length;
        results.push({ id: `${path}\0${line ?? "path"}\0${from}\0${results.length}`, path, line, text, from, to });
      }
    };
    const fullFiles = workingFiles?.files ?? [];
    const fullPaths = new Set(fullFiles.map((file) => file.path));
    fullFiles.forEach((file) => {
      collect(file.path, file.path, null);
      file.content.split(/\r\n|\n|\r/).forEach((line, index) => collect(line, file.path, index + 1));
    });
    state.files.forEach((file) => {
      if (fullPaths.has(file.path)) return;
      collect(file.path, file.path, null);
      file.lines.forEach((line) => {
        if (line.kind !== "hunk") collect(line.text, file.path, null);
      });
    });
    return { results, truncated };
  }, [findQuery, state.files, workingFiles]);

  const activeFindIndex = findMatches.results.length ? ((findIndex % findMatches.results.length) + findMatches.results.length) % findMatches.results.length : 0;
  const activeMatch = findMatches.results[activeFindIndex];

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onFind = () => {
      if (findOpen) findInputRef.current?.focus();
      setFindOpen(true);
    };
    root.addEventListener("ade:diff-find", onFind);
    return () => root.removeEventListener("ade:diff-find", onFind);
  }, [findOpen]);

  useLayoutEffect(() => {
    if (findOpen) findInputRef.current?.focus();
  }, [findOpen]);

  useEffect(() => {
    if (!findOpen || !activeMatch) return;
    resultTargets.current.get(activeMatch.id)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [findOpen, activeMatch]);

  useEffect(() => { setFindIndex(0); }, [findQuery]);

  const stepFind = (delta: -1 | 1) => {
    const count = findMatches.results.length;
    if (count) setFindIndex((current) => (current + delta + count) % count);
  };
  const closeFind = () => {
    setFindOpen(false);
    setFindQuery("");
    setFindIndex(0);
    requestAnimationFrame(() => rootRef.current?.focus());
  };
  const targetRef = (target: string) => (node: HTMLElement | null) => {
    if (node) resultTargets.current.set(target, node);
    else resultTargets.current.delete(target);
  };
  const highlightedResult = (result: DiffFindResult): ReactNode => {
    const start = Math.max(0, result.from - 90);
    const end = Math.min(result.text.length, result.to + 90);
    return <>
      {start > 0 && "…"}{result.text.slice(start, result.from)}
      <mark className="rounded-sm bg-amber-400/80 text-gray-950">{result.text.slice(result.from, result.to)}</mark>
      {result.text.slice(result.to, end)}{end < result.text.length && "…"}
    </>;
  };

  const total = useMemo(() => state.files.reduce((n, f) => ({ added: n.added + f.added, removed: n.removed + f.removed }), { added: 0, removed: 0 }), [state.files]);

  if (!state.loaded) return <p className="p-4 text-chat-note text-gray-400 dark:text-white/40">{t("chat.panel.loading")}</p>;
  if (!state.repo) return <p className="p-4 text-chat-note text-gray-400 dark:text-white/40">{t("chat.panel.noRepo")}</p>;
  if (state.files.length === 0) return <p className="p-4 text-chat-note text-gray-400 dark:text-white/40">{t("chat.panel.noChanges")}</p>;

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-ade-diff-search-root ref={rootRef} tabIndex={0}>
      {findOpen && <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-white/[0.08] bg-gray-50 dark:bg-white/[0.03]">
        <input ref={findInputRef} type="search" value={findQuery} onChange={(event) => setFindQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeFind(); }
            else if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); stepFind(event.shiftKey ? -1 : 1); }
          }}
          aria-label={t("chat.diffFind.label")} placeholder={t("chat.diffFind.placeholder")}
          className="min-w-0 flex-1 h-8 px-2.5 rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-white/[0.04] text-chat-caption text-gray-900 dark:text-white outline-none focus:border-accent-500" />
        <span className="min-w-[3.5rem] text-right text-chat-note text-gray-500 dark:text-white/45" aria-live="polite">
          {!hasFindQuery ? "" : findMatches.results.length ? t("chat.find.position", { current: activeFindIndex + 1, total: findMatches.results.length }) : workingFilesLoading ? t("chat.diffFind.readingFiles") : t("chat.find.noResults")}
        </span>
        <button type="button" onClick={() => stepFind(-1)} disabled={!findMatches.results.length} aria-label={t("chat.find.previous")} title={t("chat.find.previous")}
          className="h-7 w-7 rounded-md text-gray-600 dark:text-white/60 hover:bg-gray-200 dark:hover:bg-white/10 disabled:opacity-35">↑</button>
        <button type="button" onClick={() => stepFind(1)} disabled={!findMatches.results.length} aria-label={t("chat.find.next")} title={t("chat.find.next")}
          className="h-7 w-7 rounded-md text-gray-600 dark:text-white/60 hover:bg-gray-200 dark:hover:bg-white/10 disabled:opacity-35">↓</button>
        <button type="button" onClick={closeFind} aria-label={t("chat.find.close")} title={t("chat.find.close")}
          className="h-7 w-7 rounded-md text-gray-600 dark:text-white/60 hover:bg-gray-200 dark:hover:bg-white/10">×</button>
      </div>}
      <div className="flex-1 min-h-0 cc-scroll-hidden text-chat-caption outline-none" tabIndex={0}>
        {hasFindQuery ? <>
          {(workingFilesLoading || workingFilesFailed || workingFiles?.truncated || findMatches.truncated || state.truncated) &&
            <p className="sticky top-0 z-10 border-b border-gray-200 bg-gray-50 px-3 py-2 text-chat-note text-gray-500 dark:border-white/[0.08] dark:bg-surface-deep dark:text-white/45">
              {workingFilesLoading ? t("chat.diffFind.readingFiles") : findMatches.truncated ? t("chat.diffFind.resultsLimited") : t("chat.diffFind.partial")}
            </p>}
          {findMatches.results.length ? findMatches.results.map((result, index) => {
            const active = index === activeFindIndex;
            return <button key={`${result.id}-${index}`} ref={targetRef(result.id)} type="button" aria-current={active ? "true" : undefined}
              onClick={() => setFindIndex(index)} title={result.line ? `${result.path}:${result.line}` : result.path}
              className={`block w-full border-b border-gray-100 px-3 py-2 text-left dark:border-white/[0.05] ${active ? "bg-accent-500/10" : "hover:bg-gray-100 dark:hover:bg-white/[0.04]"}`}>
              <span className="block truncate font-mono text-chat-note text-gray-500 dark:text-white/45">
                {result.path}{result.line ? `:${result.line}` : ""}
              </span>
              <span className="block whitespace-pre-wrap break-all font-mono leading-[1.65] text-chat-caption text-gray-800 dark:text-white/80">
                {highlightedResult(result)}
              </span>
            </button>;
          }) : <p className="p-4 text-chat-note text-gray-500 dark:text-white/45">{workingFilesLoading ? t("chat.diffFind.readingFiles") : t("chat.find.noResults")}</p>}
        </> : state.files.map((file) => (
          <section key={file.path}>
            <div className="sticky top-0 flex items-center gap-2 h-9 px-3 border-b border-gray-200 dark:border-white/[0.08] bg-gray-50 dark:bg-white/[0.03] backdrop-blur">
              <span className="flex-1 truncate font-mono" title={file.path}>{file.path}</span>
              <span className="font-mono"><span className="text-emerald-700 dark:text-emerald-400">+{file.added}</span>{" "}<span className="text-red-700 dark:text-red-400">−{file.removed}</span></span>
            </div>
            <div className="font-mono leading-[1.75]" data-quotable="" data-quote-source={`${t("chat.panel.diffSource")}: ${file.path}`}>
              {file.lines.map((line, i) => <div key={i} className={`px-3 whitespace-pre-wrap break-all
                ${line.kind === "hunk" ? "text-gray-500 dark:text-white/45 bg-gray-100 dark:bg-white/[0.05]"
                  : line.kind === "add" ? "text-emerald-800 dark:text-emerald-300 bg-emerald-500/10"
                    : line.kind === "del" ? "text-red-800 dark:text-red-300 bg-red-500/10" : "text-gray-800 dark:text-white/75"}`}>
                {line.kind === "add" ? "+" : line.kind === "del" ? "-" : line.kind === "ctx" ? " " : ""}{line.text}
              </div>)}
              {file.lines.length === 0 && <div className="px-3 py-2 text-gray-500 dark:text-white/45">{t("chat.panel.binary")}</div>}
            </div>
          </section>
        ))}
        {!hasFindQuery && state.truncated && <p className="p-3 text-gray-500 dark:text-white/45">{t("chat.panel.truncated")}</p>}
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
 * A aba Terminal: um shell de verdade (PTY) na pasta da conversa, o mesmo que o «Rodar» dos blocos de código usa. Como
 * o navegador, ele não é montado aqui: esta tela reserva o espaço e publica (`setChatShell`), e o `TerminalPanel`
 * desenha a aba de shell por cima. Fechar o painel ou trocar de conversa esconde o shell, sem matá-lo.
 */
/**
 * O retângulo de um slot do painel relativo à casca do chat (`[data-chat-shell]`), que é onde o `TerminalPanel` e o
 * `ViewTabsHost` desenham. A base é procurada a partir do PAI do slot: um slot que carregasse o mesmo atributo seria a
 * própria base, e o retângulo sairia em (0, 0) — o terminal da conversa aparecia no canto de cima, por cima da sidebar.
 * `null` sem casca ou sem tamanho ainda. Pura (só lê o DOM).
 */
export function rectInShell(el: Element | null): { left: number; top: number; width: number; height: number } | null {
  const base = el?.parentElement?.closest(`[${CHAT_SHELL_ATTR}]`) ?? null;
  if (!el || !base) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  const b = base.getBoundingClientRect();
  return { left: Math.round(r.left - b.left), top: Math.round(r.top - b.top), width: Math.round(r.width), height: Math.round(r.height) };
}

function ShellSurface({ cwd, tab }: { cwd: string; tab: ColumnTab }) {
  const { t } = useTranslation();
  const slotRef = useRef<HTMLDivElement>(null);
  const scope = shellScope(cwd);
  // O shell que esta aba mostra nesta pasta. Se ele foi fechado no modo Abas, a aba pega/cria outro.
  const saved = tab.resources?.[scope] ?? null;
  const tabId = useTabsStore((s) => (saved && s.tabs.some((x) => x.id === saved) ? saved : null));
  useEffect(() => {
    if (tabId) return;
    let alive = true;
    // Os shells que as OUTRAS abas da coluna já mostram ficam de fora: cada aba é um terminal próprio.
    const taken = new Set(useChatStore.getState().columnTabs.filter((x) => x.id !== tab.id).map((x) => x.resources?.[scope]).filter((x): x is string => !!x));
    void claimShellTab(cwd, taken).then((id) => { if (alive) setColumnTabResource(tab.id, scope, id); });
    return () => { alive = false; };
  }, [tabId, tab.id, scope, cwd]);

  const measure = useCallback(() => {
    const rect = rectInShell(slotRef.current);
    if (!rect || !tabId) return setChatShell(null);
    setChatShell({ tabId, rect });
  }, [tabId]);

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
  // Só tira o que ESTE slot publicou: ao trocar de uma aba de terminal para outra, o slot novo pode já ter publicado.
  useEffect(() => () => { if (useChatStore.getState().shell?.tabId === tabId) setChatShell(null); }, [tabId]);

  return (
    <section aria-label={t("chat.shell.label")} className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-2 h-9 px-3.5 shrink-0 border-b border-gray-200 dark:border-white/[0.08] text-chat-note text-gray-500 dark:text-white/45">
        <span className="font-medium text-gray-800 dark:text-white/80">{t("chat.shell.title")}</span>
        <span className="flex-1 min-w-0 truncate font-mono text-chat-caption" title={cwd}>{cwd}</span>
      </div>
      <div className="flex-1 min-h-0 p-2 bg-white dark:bg-black">
        <div ref={slotRef} data-chat-shell-slot={tabId ?? ""} className="h-full" />
      </div>
    </section>
  );
}

/**
 * A aba Navegador: o navegador do ADE (o mesmo das abas e do canvas) para a pasta da conversa. Como o
 * terminal, ele não é montado aqui: esta tela reserva o espaço e publica, e o `ViewTabsHost` o
 * desenha por cima. Conversas TUI seguem o navegador da sessão ativa; as demais usam a tab do usuário.
 */
function browserOwnerOf(conversation: ConversationCard | null): ViewOwner | null {
  if (!conversation) return null;
  const structured = conversation.tabId.startsWith("thread:");
  return { kind: structured ? "thread" : "tab", id: conversation.tabId, label: conversation.agentLabel };
}

/** As páginas (ViewTabs de navegador) desta conversa/pasta: as candidatas a uma aba Navegador da coluna. */
function browserCandidates(views: readonly ViewTab[], cwd: string, owner: ViewOwner | null): string[] {
  return views.filter((view): view is BrowserView => view.kind === "browser"
    && comparablePath(view.cwd) === comparablePath(cwd)
    && (owner ? view.owner?.kind === owner.kind && view.owner.id === owner.id : !view.owner)).map((view) => view.id);
}

function BrowserSurface({ cwd, owner, tab }: { cwd: string; owner: ViewOwner | null; tab: ColumnTab }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const floating = useChatStore((s) => s.browserFloating);
  const scope = browserScope(cwd, owner);
  // Cada aba mostra a própria página, e cada conversa as suas; a tela de conversa nova usa uma tab do usuário.
  // Uma aba que pediu um perfil (submenu do Browser) não reaproveita página: nasce uma nova nesse perfil.
  const pickView = (views: readonly ViewTab[], tabs: readonly ColumnTab[]) => {
    const current = tabs.find((x) => x.id === tab.id) ?? tab;
    const wantsNew = !!current.profileId && !current.resources?.[scope];
    return pickResource(current, scope, wantsNew ? [] : browserCandidates(views, cwd, owner), tabs);
  };
  const columnTabs = useChatStore((s) => s.columnTabs);
  const viewId = useViewTabsStore((s) => pickView(s.views, columnTabs));

  useEffect(() => {
    // Consulte o estado atual antes de criar: o efeito pode ser repetido no StrictMode ou
    // outro componente pode ter aberto a tab depois da primeira renderização.
    const views = useViewTabsStore.getState().views;
    const tabs = useChatStore.getState().columnTabs;
    let id = pickView(views, tabs);
    if (!id) {
      id = useViewTabsStore.getState().openBrowser(cwd, "", { activate: false, owner: owner ?? undefined });
      if (tab.profileId) useViewTabsStore.getState().updateView(id, { browserProfileId: tab.profileId });
    }
    setColumnTabResource(tab.id, scope, id);
  }, [cwd, owner?.kind, owner?.id, owner?.label, tab.id, scope, viewId]); // eslint-disable-line react-hooks/exhaustive-deps

  const measure = useCallback(() => {
    if (floating) return;
    const rect = rectInShell(slotRef.current);
    if (!rect || !viewId) return setChatBrowser(null);
    setChatBrowser({ viewId, rect });
  }, [viewId, floating]);

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
  useEffect(() => () => {
    // Ao destacar, o slot desmonta, mas o mesmo BrowserTab continua visível no retângulo flutuante.
    // Só tira o que ESTE slot publicou: na troca entre duas abas de navegador o slot novo pode já ter publicado.
    const state = useChatStore.getState();
    if (!state.browserFloating && state.browser?.viewId === viewId) setChatBrowser(null);
  }, [viewId]);

  return <div ref={slotRef} data-chat-browser-slot={viewId ?? ""} className="flex-1 min-h-0" />;
}
