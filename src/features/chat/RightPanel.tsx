import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";

import { FilesView } from "@/features/explorer/FilesView";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { comparablePath, type ViewTab } from "@/features/tabs/viewTabs";

import { useSimulatorStore } from "@/features/simulator/store";

import { GlobeIcon, MaximizeIcon, PhoneIcon, PlusIcon, XIcon } from "./chatIcons";
import { parseUnifiedDiff, type FileDiff } from "./diffModel";
import { scmWorkingDiff } from "./ipc";
import { CHAT_SHELL_ATTR } from "./ConversationView";
import { addSurface, hostLabel, removeSurface, setChatBrowser, setRightPanel, SURFACES, togglePanelMaximized, useChatStore, type Surface } from "./store";
import { usePopover } from "./usePopover";

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
  const surfaces = useChatStore((s) => s.surfaces);
  // As abas levam o nome do que mostram (prancheta 8): o endereço do navegador, o aparelho ligado.
  const browserUrl = useViewTabsStore((s) =>
    cwd ? s.views.find((v): v is Extract<ViewTab, { kind: "browser" }> => v.kind === "browser" && !v.owner && comparablePath(v.cwd) === comparablePath(cwd))?.url ?? null : null);
  const device = useSimulatorStore((s) => s.devices.find((d) => d.state === "booted")?.name ?? null);
  if (!panel) return null;
  const label = (surface: Surface) =>
    surface === "browser" ? hostLabel(browserUrl) ?? t("chat.panel.browser")
    : surface === "devices" ? device ?? t("chat.panel.devices")
    : t(`chat.panel.${surface}`);
  const icon = (surface: Surface) =>
    surface === "browser" ? <GlobeIcon className="w-3 h-3 shrink-0" /> : surface === "devices" ? <PhoneIcon className="w-3 h-3 shrink-0" /> : null;
  const tabCls = (on: boolean) => `h-6 max-w-40 px-2 rounded-md text-[12px] inline-flex items-center gap-1.5
    ${on ? "bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-white font-medium" : "text-gray-500 dark:text-white/45 hover:bg-gray-100/60 dark:hover:bg-white/[0.06]"}`;
  return (
    <aside aria-label={t("chat.panel.label")}
      style={maximized ? undefined : { width: RIGHT_PANEL_W }}
      className={`${maximized ? "flex-1" : "shrink"} min-w-[360px] h-full flex flex-col border-l border-gray-200 dark:border-white/[0.08] bg-white dark:bg-surface-deep`}>
      <div role="tablist" data-tauri-drag-region className="h-[52px] shrink-0 flex items-center gap-1 pl-2 pr-3">
        <button type="button" role="tab" aria-selected={panel === "diff"} onClick={() => setRightPanel("diff")} className={tabCls(panel === "diff")}>
          {t("chat.panel.diff")}
        </button>
        {surfaces.map((surface) => (
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
        <AddSurface open={surfaces} />
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

/** O "+" do painel: abre Navegador, Arquivos, Design ou Dispositivos (os que ainda não estão abertos). */
function AddSurface({ open: opened }: { open: Surface[] }) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const missing = SURFACES.filter((s) => !opened.includes(s));
  if (missing.length === 0) return null;
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} aria-label={t("chat.panel.add")} title={t("chat.panel.add")} aria-expanded={open}
        className="w-6 h-6 flex items-center justify-center rounded-md text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/10">
        <PlusIcon className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-full mt-1 z-50 min-w-[160px] p-1 rounded-lg bg-white dark:bg-surface-raised
          shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_16px_40px_-18px_rgba(0,0,0,0.55)]">
          {missing.map((s) => (
            <button key={s} type="button" role="menuitem" onClick={() => { addSurface(s); setOpen(false); }}
              className="w-full h-8 px-2 rounded-md text-left text-[13px] text-gray-800 dark:text-white/85 hover:bg-gray-100 dark:hover:bg-white/[0.07]">
              {t(`chat.panel.${s}`)}
            </button>
          ))}
        </div>
      )}
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
