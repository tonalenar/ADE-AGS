import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import type { DesktopAppView } from "@/features/tabs/viewTabs";
import { currentLayout, focusGroup, useLayoutStore } from "@/features/tabs/layout/layoutStore";
import { groupOf, viewKey } from "@/features/tabs/layout/layoutTree";
import { applyDesktopPlan, desktopAttach, desktopDetach, desktopLayout, desktopStatus, desktopTasks, executeConsult, retryConsult, updateConsult, type Consult, type DesktopStatus } from "./ipc";
import { hasNativeOverlay, panelBounds } from "./geometry";
import { GeminiTeamPanel } from "./GeminiTeamPanel";

const button = "rounded-md border border-gray-300 dark:border-white/15 px-3 py-1.5 text-xs disabled:opacity-40 hover:bg-black/5 dark:hover:bg-white/5";

export default function GeminiDesktopTab({ view, active, canvas = false }: { view: DesktopAppView; active: boolean; canvas?: boolean }) {
  const { t } = useTranslation();
  const dragging = useLayoutStore((s) => s.drag !== null);
  const surface = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const attachedNow = useRef(false);
  const attempted = useRef(false);
  const refreshId = useRef(0);
  const pumping = useRef(false);
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [attached, setAttached] = useState(false);
  const [busy, setBusy] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const [tasks, setTasks] = useState<Consult[]>([]);
  const [inbox, setInbox] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [response, setResponse] = useState("");
  const [planResult, setPlanResult] = useState("");
  const scopedTasks = tasks.filter((task) => task.cwd === view.cwd);
  const selection = scopedTasks.find((task) => task.id === selected);
  const pending = scopedTasks.filter((task) => task.status === "queued" || task.status === "working");

  const refresh = useCallback(async () => {
    const id = ++refreshId.current;
    try { const items = await desktopTasks(view.cwd); if (mounted.current && id === refreshId.current) setTasks(items); }
    catch (e) { if (mounted.current && id === refreshId.current) setError(String(e)); }
  }, [view.cwd]);

  const pump = useCallback(async () => {
    if (!attached || status?.ownerView !== view.id || pumping.current) return;
    pumping.current = true;
    setProcessing(true);
    setError("");
    try {
      while (mounted.current && attachedNow.current) {
        const current = await desktopTasks(view.cwd);
        if (mounted.current) setTasks(current);
        const next = current.find((task) => task.status === "queued" || (task.status === "working" && !task.response));
        if (!next) break;
        const result = await executeConsult(view.id, view.cwd, next.id);
        if (mounted.current) {
          setTasks((items) => items.map((task) => task.id === result.id ? result : task));
          if (result.role === "lead" && result.response) {
            setSelected(result.id);
            setResponse(result.response);
          }
        }
        // A Lead's plan waits for user review and application before the run can continue.
        if (result.status === "working") break;
      }
    } catch (e) {
      if (mounted.current) { setError(String(e)); await refresh(); }
    } finally {
      pumping.current = false;
      if (mounted.current) setProcessing(false);
    }
  }, [attached, status?.ownerView, view.id, view.cwd, refresh]);

  useEffect(() => {
    attachedNow.current = attached;
  }, [attached]);

  useEffect(() => {
    mounted.current = true;
    void desktopStatus().then((s) => {
      if (!mounted.current) return;
      setStatus(s);
      if (s.attached && s.ownerView === view.id) { attempted.current = true; setAttached(true); }
    }).catch((e) => { if (mounted.current) setError(String(e)); });
    return () => { mounted.current = false; if (attempted.current) void desktopDetach(view.id).catch(console.error); };
  }, [view.id]);

  useEffect(() => {
    let cancelled = false;
    void refresh();
    const stop = listen("gemini-desktop-tasks-changed", () => { if (!cancelled) { void refresh(); void pump(); } });
    const stopRuns = listen("cc-task-changed", () => { if (!cancelled) { void refresh(); void pump(); } });
    return () => { cancelled = true; void stop.then((unlisten) => unlisten()); void stopRuns.then((unlisten) => unlisten()); };
  }, [refresh, pump]);

  useEffect(() => { void pump(); }, [pump]);

  useEffect(() => {
    const stop = listen<string>("gemini-desktop-error", (event) => setError(event.payload));
    return () => { void stop.then((unlisten) => unlisten()); };
  }, []);

  useEffect(() => {
    const stop = listen<string>("gemini-desktop-focus", (event) => {
      if (event.payload !== view.id || canvas) return;
      const layout = currentLayout();
      const group = layout && groupOf(layout, viewKey(view.id));
      if (group) focusGroup(group.id);
    });
    return () => { void stop.then((unlisten) => unlisten()); };
  }, [view.id, canvas]);

  useEffect(() => { setSelected(null); setResponse(""); }, [view.cwd]);
  useEffect(() => { if (selection?.response) setResponse(selection.response); }, [selection?.id, selection?.response]);

  useEffect(() => {
    if (!attached || !surface.current) return;
    const el = surface.current;
    let frame = 0, stopped = false, sending = false, dirty = false, previous = "";
    const update = async () => {
      if (stopped) return;
      if (sending) { dirty = true; return; }
      const bounds = panelBounds(el.getBoundingClientRect(), window.devicePixelRatio, active && !document.hidden, dragging || hasNativeOverlay());
      const key = JSON.stringify(bounds);
      if (key === previous) return;
      sending = true; dirty = false;
      try { await desktopLayout(view.id, bounds); previous = key; }
      catch (e) { if (!stopped) { setError(String(e)); setAttached(false); } }
      finally { sending = false; if (dirty && !stopped) void update(); }
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { void update(); }); };
    const resize = new ResizeObserver(schedule); resize.observe(el);
    const overlays = new MutationObserver(schedule); overlays.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "class", "style", "role", "popover"] });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    window.addEventListener("pointerdown", schedule, true);
    window.addEventListener("pointerup", schedule, true);
    schedule();
    return () => {
      stopped = true; cancelAnimationFrame(frame); resize.disconnect(); overlays.disconnect();
      window.removeEventListener("resize", schedule); window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", schedule);
      document.removeEventListener("focusin", schedule); document.removeEventListener("focusout", schedule);
      window.removeEventListener("pointerdown", schedule, true); window.removeEventListener("pointerup", schedule, true);
      // Serialize the hide after any in-flight layout to prevent a late request showing it.
      void desktopLayout(view.id, { x: 0, y: 0, width: 0, height: 0, scale: 1, visible: false }).catch(console.error);
    };
  }, [attached, active, dragging, view.id]);

  const connect = async () => {
    attempted.current = true;
    setBusy(true); setError("");
    try {
      const s = await desktopAttach(view.id);
      if (!mounted.current) { await desktopDetach(view.id); return; }
      attachedNow.current = true;
      setStatus(s); setAttached(true);
    } catch (e) { if (mounted.current) setError(String(e)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const release = async () => {
    setBusy(true);
    try { await desktopDetach(view.id); attempted.current = false; attachedNow.current = false; setAttached(false); setStatus(await desktopStatus()); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const complete = async () => {
    if (!selection) return;
    setBusy(true);
    try { await updateConsult(view.cwd, selection.id, "completed", response); setResponse(""); await refresh(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const retry = async () => {
    if (!selection) return;
    setBusy(true); setError("");
    try { await retryConsult(view.cwd, selection.id); await refresh(); void pump(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  return <div className="flex h-full flex-col bg-white dark:bg-surface text-gray-800 dark:text-gray-200">
    <div className="flex shrink-0 items-center gap-2 border-b border-gray-200 dark:border-white/10 px-3 py-2">
      <span className="text-blue-500" aria-hidden="true">✦</span><strong className="text-sm whitespace-nowrap">Gemini Desktop</strong>
      <span className="hidden text-[10px] text-gray-500">{t("geminiDesktop.experimental")}</span>
      <div className="flex-1" />
      <button className={button} onClick={() => setInbox((v) => !v)} aria-expanded={inbox}>{t("geminiDesktop.consults")} ({pending.length}) · {t("geminiDesktop.team")}</button>
      <button className={button} disabled={busy || (!attached && !status?.supported)} onClick={() => void (attached ? release() : connect())}>
        {busy ? t("geminiDesktop.wait") : attached ? t("geminiDesktop.release") : t("geminiDesktop.connect")}
      </button>
      {processing && <span role="status" className="max-w-48 truncate text-[10px] text-gray-500">{t("geminiDesktop.processing")}</span>}
    </div>
    {error && <div role="alert" className="shrink-0 border-b border-red-300 p-2 text-xs text-red-600">{error}</div>}
    <div className="flex min-h-0 flex-1">
      <div ref={surface} className="relative min-w-0 flex-1">
        {!attached && <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <span className="text-4xl text-blue-500" aria-hidden="true">✦</span>
          <p className="max-w-md text-sm">{status && !status.supported ? t("geminiDesktop.windowsOnly") : status && !status.installed ? t("geminiDesktop.notInstalled") : t("geminiDesktop.intro")}</p>
          <p className="max-w-md text-xs text-gray-500">{t("geminiDesktop.automatic")}</p>
        </div>}
      </div>
      {inbox && <aside className="flex w-80 shrink-0 flex-col gap-2 overflow-y-auto border-l border-gray-200 dark:border-white/10 p-3" aria-label={t("geminiDesktop.consults")}>
        <GeminiTeamPanel cwd={view.cwd} />
        <p className="text-xs text-gray-500">{t("geminiDesktop.automatic")}</p>
        {scopedTasks.length === 0 && <p className="text-sm">{t("geminiDesktop.empty")}</p>}
        {scopedTasks.map((task) => <button key={task.id} className={`${button} text-left ${selected === task.id ? "border-blue-500!" : ""}`}
          onClick={() => { setSelected(task.id); setResponse(task.response ?? ""); setPlanResult(""); }}>
          <span className="block truncate">{task.prompt}</span><span className="text-[10px] opacity-60">{t(`geminiDesktop.states.${task.status}`)}</span>
        </button>)}
        {selection && <>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/5 p-2 text-xs dark:bg-white/5">{selection.prompt}</pre>
          {(selection.status === "queued" || selection.status === "working") && !selection.response && <p role="status" className="text-xs text-gray-500">
            {attached ? t("geminiDesktop.sending") : t("geminiDesktop.waitingConnection")}
          </p>}
          {selection.status === "working" && selection.response && selection.role === "lead" && <>
            <label className="text-xs">{t("geminiDesktop.response")}<textarea value={response} readOnly={!!planResult} onChange={(e) => setResponse(e.target.value)} rows={7}
              className="mt-1 w-full rounded-md border border-gray-300 bg-transparent p-2 dark:border-white/15" /></label>
            <p className="text-xs text-gray-500">{t("geminiDesktop.planHint")}</p>
            <button className={button} disabled={busy || !response.trim() || !!planResult} onClick={() => { void (async () => {
              setBusy(true); setError("");
              try { await applyDesktopPlan(view.cwd, selection.id, response); setPlanResult(t("geminiDesktop.planApplied")); }
              catch (e) { setError(String(e)); }
              finally { setBusy(false); }
            })(); }}>{t("geminiDesktop.applyPlan")}</button>
            {planResult && <>
              <p role="status" className="text-xs text-green-600">{planResult}</p>
              <button className={button} disabled={busy || !response.trim()} onClick={() => void complete()}>{t("geminiDesktop.deliver")}</button>
            </>}
          </>}
          {selection.status === "queued" && <>
            {error && attached && <button className={button} disabled={processing} onClick={() => void pump()}>{t("geminiDesktop.retry")}</button>}
            <button className={button} disabled={processing} onClick={() => { void updateConsult(view.cwd, selection.id, "cancelled").then(refresh).catch((e) => setError(String(e))); }}>{t("geminiDesktop.cancel")}</button>
          </>}
          {selection.error && <p className="text-xs text-red-500">{selection.error}</p>}
          {selection.status === "failed" && !selection.runTaskId && <button className={button} disabled={busy || processing} onClick={() => void retry()}>{t("geminiDesktop.retry")}</button>}
          {selection.status === "completed" && <pre className="whitespace-pre-wrap break-words text-xs">{selection.response}</pre>}
        </>}
      </aside>}
    </div>
  </div>;
}
