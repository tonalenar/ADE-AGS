import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";

import { FilesView } from "@/features/explorer/FilesView";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { comparablePath } from "@/features/tabs/viewTabs";

import { MaximizeIcon } from "./chatIcons";
import { parseUnifiedDiff, type FileDiff } from "./diffModel";
import { scmWorkingDiff } from "./ipc";
import { CHAT_SHELL_ATTR } from "./ConversationView";
import { setChatBrowser, setRightPanel, togglePanelMaximized, useChatStore, type RightPanelTab } from "./store";

// Design e Dispositivos puxam o canvas (`@xyflow/react`): ficam fora do grafo estático do entry.
const DesignPane = lazy(() => import("./DesignPane").then((m) => ({ default: m.DesignPane })));
const DevicesPane = lazy(() => import("./DevicesPane").then((m) => ({ default: m.DevicesPane })));

/** A largura do painel (a padrão do T3 Code). */
export const RIGHT_PANEL_W = 540;

/**
 * O painel direito da prancheta 2: abas no topo (Diff, Arquivos), o conteúdo embaixo. O Diff é o
 * `git diff` de verdade da pasta da conversa, relido quando o agente trabalha.
 */
export function RightPanel({ tabId, cwd, project }: { tabId: string | null; cwd: string | null; project: string }) {
  const { t } = useTranslation();
  const panel = useChatStore((s) => s.panel);
  const maximized = useChatStore((s) => s.panelMaximized);
  if (!panel) return null;
  const tabs: { id: RightPanelTab; label: string }[] = [
    { id: "diff", label: t("chat.panel.diff") },
    { id: "files", label: t("chat.panel.files") },
    { id: "browser", label: t("chat.panel.browser") },
    { id: "design", label: t("chat.panel.design") },
    { id: "devices", label: t("chat.panel.devices") },
  ];
  return (
    <aside aria-label={t("chat.panel.label")}
      style={maximized ? undefined : { width: RIGHT_PANEL_W }}
      className={`${maximized ? "flex-1" : "shrink"} min-w-[360px] h-full flex flex-col border-l border-gray-200 dark:border-white/[0.08] bg-white dark:bg-surface-deep`}>
      <div role="tablist" data-tauri-drag-region className="h-[52px] shrink-0 flex items-center gap-1 pl-2 pr-3">
        {tabs.map((tab) => (
          <button key={tab.id} type="button" role="tab" aria-selected={panel === tab.id} onClick={() => setRightPanel(tab.id)}
            className={`h-6 max-w-36 px-2 rounded-md text-[12px] truncate
              ${panel === tab.id ? "bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-white font-medium" : "text-gray-500 dark:text-white/45 hover:bg-gray-100/60 dark:hover:bg-white/[0.06]"}`}>
            {tab.label}
          </button>
        ))}
        <span data-tauri-drag-region className="flex-1 self-stretch" />
        <button type="button" onClick={togglePanelMaximized} aria-pressed={maximized} aria-label={t("chat.panel.maximize")} title={t("chat.panel.maximize")}
          className="w-7 h-7 flex items-center justify-center rounded-md text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/10">
          <MaximizeIcon className="w-[15px] h-[15px]" />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col border-t border-gray-200 dark:border-white/[0.08]">
        {panel === "diff" && <DiffView tabId={tabId} cwd={cwd} />}
        {panel === "files" && cwd && <FilesView cwd={cwd} repo={null} title={project} />}
        {panel === "browser" && cwd && <BrowserSurface cwd={cwd} />}
        {(panel === "design" || panel === "devices") && (
          <Suspense fallback={<p className="p-4 text-[13px] text-gray-400 dark:text-white/40">{t("chat.panel.loading")}</p>}>
            {panel === "design" ? <DesignPane cwd={cwd} /> : <DevicesPane />}
          </Suspense>
        )}
      </div>
    </aside>
  );
}

/** Quanto esperar depois do último aviso de "a conversa cresceu" para reler o diff. */
const DIFF_DEBOUNCE_MS = 1500;

function DiffView({ tabId, cwd }: { tabId: string | null; cwd: string | null }) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ files: FileDiff[]; truncated: boolean; loaded: boolean; repo: boolean }>({ files: [], truncated: false, loaded: false, repo: true });
  const timer = useRef<number | null>(null);

  const load = useCallback(() => {
    if (!cwd) return;
    scmWorkingDiff(cwd)
      .then((diff) => setState({ files: diff ? parseUnifiedDiff(diff.text) : [], truncated: diff?.truncated ?? false, loaded: true, repo: diff !== null }))
      .catch(() => setState((s) => ({ ...s, loaded: true })));
  }, [cwd]);

  useEffect(() => {
    load();
    if (!tabId) return;
    const off = listen<{ tabId: string }>("cc-conversation-grew", (e) => {
      if (e.payload.tabId !== tabId) return;
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(load, DIFF_DEBOUNCE_MS);
    });
    return () => {
      off.then((fn) => fn()).catch(() => undefined);
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [load, tabId]);

  const total = useMemo(() => state.files.reduce((n, f) => ({ added: n.added + f.added, removed: n.removed + f.removed }), { added: 0, removed: 0 }), [state.files]);

  if (!state.loaded) return <p className="p-4 text-[13px] text-gray-400 dark:text-white/40">{t("chat.panel.loading")}</p>;
  if (!state.repo) return <p className="p-4 text-[13px] text-gray-400 dark:text-white/40">{t("chat.panel.noRepo")}</p>;
  if (state.files.length === 0) return <p className="p-4 text-[13px] text-gray-400 dark:text-white/40">{t("chat.panel.noChanges")}</p>;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 cc-scroll text-[12px]">
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
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-t border-gray-200 dark:border-white/[0.08] text-[12.5px] text-gray-500 dark:text-white/45">
        <span className="flex-1">{t("chat.panel.summary", { count: state.files.length, added: total.added, removed: total.removed })}</span>
        <button type="button" onClick={load}
          className="h-7 px-3 rounded-lg border border-gray-200 dark:border-white/10 text-[13px] text-gray-800 dark:text-white/80 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
          {t("chat.panel.refresh")}
        </button>
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
