import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { DESKTOP_OS } from "@/app/platform";
import { forgeErrorOf, type ForgeItem, type ForgeKind, type PullCodeFile, type PullFileContent, type PullReviewAction, type PullReviewCommentDraft, type PullReviewThread } from "./types";
import { forgePullCode, forgePullFileContents, forgePullReviewThreads, forgeReplyPullReviewThread, forgeSetPullReviewThreadResolved, forgeSubmitPullReview } from "./ipc";

type FilesState = { status: "loading" } | {
  status: "ready";
  headSha: string;
  baseSha: string | null;
  startSha: string | null;
  provider: ForgeKind;
  files: PullCodeFile[];
} | { status: "error"; message: string };

interface DiffLine {
  kind: "meta" | "context" | "added" | "removed";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

interface CommentTarget {
  path: string;
  oldLine: number | null;
  newLine: number | null;
}

function parseUnifiedDiff(patch: string): { lines: DiffLine[]; truncated: boolean } {
  const lines: DiffLine[] = [];
  let oldLine: number | null = null;
  let newLine: number | null = null;
  let offset = 0;
  const maxLines = 2_000;
  while (offset < patch.length && lines.length < maxLines) {
    const end = patch.indexOf("\n", offset);
    const raw = patch.slice(offset, end < 0 ? patch.length : end).replace(/\r$/, "");
    offset = end < 0 ? patch.length : end + 1;
    if (raw.startsWith("@@")) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      oldLine = hunk ? Number(hunk[1]) : null;
      newLine = hunk ? Number(hunk[2]) : null;
      lines.push({ kind: "meta", oldLine: null, newLine: null, text: raw });
    } else if (raw.startsWith("+") && !raw.startsWith("+++")) {
      lines.push({ kind: "added", oldLine: null, newLine, text: raw.slice(1) });
      newLine = newLine === null ? null : newLine + 1;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      lines.push({ kind: "removed", oldLine, newLine: null, text: raw.slice(1) });
      oldLine = oldLine === null ? null : oldLine + 1;
    } else if (raw.startsWith(" ")) {
      lines.push({ kind: "context", oldLine, newLine, text: raw.slice(1) });
      oldLine = oldLine === null ? null : oldLine + 1;
      newLine = newLine === null ? null : newLine + 1;
    } else {
      lines.push({ kind: "meta", oldLine: null, newLine: null, text: raw });
    }
  }
  return { lines, truncated: offset < patch.length };
}

interface SearchHit {
  path: string;
  line: number;
  excerpt: string;
}

function isSnapshotChange(error: unknown): boolean {
  return forgeErrorOf(error).message.startsWith("PR_HEAD_CHANGED:");
}

function countLines(text: string): number {
  if (!text) return 0;
  let count = 1;
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) count++;
  return text.endsWith("\n") ? count - 1 : count;
}

function reviewTargetKey(path: string, oldLine: number | null, newLine: number | null): string {
  return `${path}\0${oldLine ?? ""}\0${newLine ?? ""}`;
}

/** Código no commit atual do PR, carregado por arquivo e pesquisável sob demanda. */
export function PullRequestCodeTab({ cwd, item }: { cwd: string; item: ForgeItem }) {
  const { t } = useTranslation();
  const [filesState, setFilesState] = useState<FilesState>({ status: "loading" });
  const [selectedPath, setSelectedPath] = useState("");
  const [contents, setContents] = useState<Record<string, PullFileContent>>({});
  const [fileLoadError, setFileLoadError] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"file" | "diff">("file");
  const [searchState, setSearchState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [searchError, setSearchError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [drafts, setDrafts] = useState<PullReviewCommentDraft[]>([]);
  const [commentTarget, setCommentTarget] = useState<CommentTarget | null>(null);
  const [commentText, setCommentText] = useState("");
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [reviewSummary, setReviewSummary] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewFeedback, setReviewFeedback] = useState("");
  const [reviewPanelOpen, setReviewPanelOpen] = useState(false);
  const [reviewAction, setReviewAction] = useState<PullReviewAction>("comment");
  const [threads, setThreads] = useState<PullReviewThread[]>([]);
  const [threadsStatus, setThreadsStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [threadsError, setThreadsError] = useState("");
  const [threadsTruncated, setThreadsTruncated] = useState(false);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [threadJumpVersion, setThreadJumpVersion] = useState(0);
  const [threadReplyDrafts, setThreadReplyDrafts] = useState<Record<string, string>>({});
  const [threadBusyId, setThreadBusyId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const codeScrollRef = useRef<HTMLDivElement>(null);
  const pendingLineRef = useRef<number | null>(null);
  const pendingThreadLineRef = useRef<{ line: number; side: "LEFT" | "RIGHT" | null } | null>(null);
  const searchLoadStarted = useRef(false);

  const reloadCode = useCallback(async () => {
    setFilesState({ status: "loading" });
    setContents({});
    setFileLoadError("");
    setTruncated(false);
    setSearchError("");
    setSearchState("idle");
    searchLoadStarted.current = false;
    setDrafts([]);
    setCommentTarget(null);
    setCommentText("");
    setEditingDraftId(null);
    setReviewFeedback("");
    setReviewPanelOpen(false);
    setThreads([]);
    setThreadsStatus("idle");
    setThreadsError("");
    setThreadsTruncated(false);
    setThreadsOpen(false);
    setThreadReplyDrafts({});
    try {
      const snapshot = await forgePullCode(cwd, item.number);
      setFilesState({
        status: "ready",
        headSha: snapshot.headSha,
        baseSha: snapshot.baseSha,
        startSha: snapshot.startSha,
        provider: snapshot.provider,
        files: snapshot.files,
      });
      const first = snapshot.files.find((file) => file.status !== "removed") ?? snapshot.files[0];
      setSelectedPath(first?.path ?? "");
      setViewMode(first?.status === "removed" ? "diff" : "file");
    } catch (error) {
      setFilesState({ status: "error", message: forgeErrorOf(error).message });
    }
  }, [cwd, item.number]);

  useEffect(() => { void reloadCode(); }, [reloadCode]);

  const loadContents = useCallback(async (paths: string[]) => {
    if (filesState.status !== "ready") return;
    const known = contents;
    const missing = [...new Set(paths)].filter((path) => !known[path]);
    if (!missing.length) return;
    try {
      const result = await forgePullFileContents(cwd, item.number, filesState.headSha, missing);
      setContents((current) => ({ ...current, ...Object.fromEntries(result.files.map((file) => [file.path, file])) }));
      setTruncated((current) => current || result.truncated);
    } catch (error) {
      if (isSnapshotChange(error)) await reloadCode();
      throw error;
    }
  }, [contents, cwd, filesState, item.number, reloadCode]);

  useEffect(() => {
    if (!selectedPath || filesState.status !== "ready" || contents[selectedPath]) return;
    const selected = filesState.files.find((file) => file.path === selectedPath);
    if (selected && selected.status !== "removed") {
      setFileLoadError("");
      loadContents([selectedPath]).catch((error) => {
        if (!isSnapshotChange(error)) setFileLoadError(forgeErrorOf(error).message);
      });
    }
  }, [contents, filesState, loadContents, selectedPath]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const openSearch = () => {
      setSearchOpen(true);
      requestAnimationFrame(() => searchRef.current?.focus());
    };
    root.addEventListener("ade:diff-find", openSearch);
    return () => root.removeEventListener("ade:diff-find", openSearch);
  }, []);

  useEffect(() => {
    if (searchOpen) requestAnimationFrame(() => searchRef.current?.focus());
  }, [searchOpen]);

  useEffect(() => {
    if (!query.trim() || filesState.status !== "ready" || searchLoadStarted.current) return;
    searchLoadStarted.current = true;
    setSearchState("loading");
    setSearchError("");
    const paths = filesState.files.filter((file) => file.status !== "removed").map((file) => file.path);
    loadContents(paths)
      .then(() => setSearchState("ready"))
      .catch((error) => {
        searchLoadStarted.current = false;
        if (isSnapshotChange(error)) return;
        setSearchState("error");
        setSearchError(forgeErrorOf(error).message);
      });
  }, [contents, filesState, loadContents, query]);

  const hits = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [] as SearchHit[];
    const result: SearchHit[] = [];
    for (const file of Object.values(contents)) {
      if (!file.content) continue;
      const searchText = file.content.toLowerCase();
      let from = 0;
      let line = 1;
      let lineStart = 0;
      let lineEnd = file.content.indexOf("\n");
      while (from < searchText.length && result.length < 500) {
        const match = searchText.indexOf(needle, from);
        if (match < 0) break;
        while (lineEnd >= 0 && lineEnd < match) {
          line++;
          lineStart = lineEnd + 1;
          lineEnd = file.content.indexOf("\n", lineStart);
        }
        const lineText = file.content.slice(lineStart, lineEnd < 0 ? file.content.length : lineEnd).replace(/\r$/, "");
        const column = match - lineStart;
        const start = Math.max(0, column - 36);
        result.push({ path: file.path, line, excerpt: `${start ? "…" : ""}${lineText.slice(start, start + 100)}${lineText.length > start + 100 ? "…" : ""}` });
        from = match + 1;
      }
      if (result.length >= 500) break;
    }
    return result;
  }, [contents, query]);

  const selectedFile = filesState.status === "ready" ? filesState.files.find((file) => file.path === selectedPath) : undefined;
  const selectedContent = contents[selectedPath];
  const code = selectedContent?.content ?? "";
  const lineCount = useMemo(() => countLines(code), [code]);
  const showLineNumbers = lineCount <= 20_000;
  const lineNumbers = useMemo(() => showLineNumbers ? Array.from({ length: lineCount }, (_, index) => index + 1).join("\n") : "", [lineCount, showLineNumbers]);
  const parsedDiff = useMemo(
    () => selectedFile?.patch ? parseUnifiedDiff(selectedFile.patch) : { lines: [] as DiffLine[], truncated: false },
    [selectedFile?.patch]
  );
  const findShortcut = DESKTOP_OS === "macos" ? "⌘F" : "Ctrl+F";
  const reviewActions: PullReviewAction[] = filesState.status !== "ready"
    ? []
    : filesState.provider === "gitlab"
      ? ["comment", "approve"]
      : filesState.provider === "github" || filesState.provider === "gitea"
        ? ["comment", "approve", "requestChanges"]
        : [];
  const canSubmitReview = filesState.status === "ready"
    && !reviewBusy
    && reviewActions.includes(reviewAction)
    && (reviewAction !== "comment" || drafts.length > 0)
    && (reviewAction !== "requestChanges" || Boolean(reviewSummary.trim()));

  const loadThreads = async () => {
    if (filesState.status !== "ready") return;
    setThreadsStatus("loading");
    setThreadsError("");
    try {
      const result = await forgePullReviewThreads(cwd, item.number, filesState.headSha);
      setThreads(result.threads);
      setThreadsTruncated(result.truncated);
      setThreadsStatus("ready");
    } catch (error) {
      setThreadsError(forgeErrorOf(error).message);
      setThreadsStatus("error");
    }
  };

  const openThreads = () => {
    const opening = !threadsOpen;
    setThreadsOpen(opening);
    if (opening && (threadsStatus === "idle" || threadsStatus === "error")) void loadThreads();
  };

  const openThreadLocation = (thread: PullReviewThread) => {
    if (!thread.path || !thread.line) return;
    pendingThreadLineRef.current = { line: thread.line, side: thread.side };
    setFileLoadError("");
    setSelectedPath(thread.path);
    setViewMode("diff");
    setThreadJumpVersion((current) => current + 1);
  };

  const submitThreadReply = async (thread: PullReviewThread) => {
    if (filesState.status !== "ready" || threadBusyId || !thread.canReply) return;
    const body = threadReplyDrafts[thread.id]?.trim();
    if (!body) return;
    setThreadBusyId(thread.id);
    setThreadsError("");
    try {
      await forgeReplyPullReviewThread(cwd, item.number, filesState.headSha, thread.replyToId, body);
      setThreadReplyDrafts((current) => ({ ...current, [thread.id]: "" }));
      await loadThreads();
    } catch (error) {
      setThreadsError(forgeErrorOf(error).message);
    } finally {
      setThreadBusyId(null);
    }
  };

  const toggleThreadResolved = async (thread: PullReviewThread) => {
    if (filesState.status !== "ready" || threadBusyId || !thread.canResolve) return;
    setThreadBusyId(thread.id);
    setThreadsError("");
    try {
      await forgeSetPullReviewThreadResolved(cwd, item.number, filesState.headSha, thread.id, !thread.resolved);
      await loadThreads();
    } catch (error) {
      setThreadsError(forgeErrorOf(error).message);
    } finally {
      setThreadBusyId(null);
    }
  };

  useEffect(() => {
    const line = pendingLineRef.current;
    if (!line || !selectedContent?.content || !codeScrollRef.current) return;
    codeScrollRef.current.scrollTo({ top: Math.max(0, (line - 1) * 20), behavior: "smooth" });
    pendingLineRef.current = null;
  }, [selectedContent, selectedPath]);

  useEffect(() => {
    const pending = pendingThreadLineRef.current;
    const scroller = codeScrollRef.current;
    if (!pending || !scroller || viewMode !== "diff") return;
    const side = pending.side === "LEFT" ? "old" : "new";
    const row = scroller.querySelector<HTMLElement>(`[data-${side}-line="${pending.line}"]`);
    if (row) {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      pendingThreadLineRef.current = null;
    }
  }, [parsedDiff, selectedPath, threadJumpVersion, viewMode]);

  const selectHit = (hit: SearchHit) => {
    pendingLineRef.current = hit.line;
    setFileLoadError("");
    setViewMode("file");
    setSelectedPath(hit.path);
  };

  const saveDraft = () => {
    if (!commentTarget || !commentText.trim()) return;
    if (editingDraftId) {
      setDrafts((current) => current.map((draft) => draft.id === editingDraftId ? { ...draft, body: commentText.trim() } : draft));
    } else {
      setDrafts((current) => [...current, {
        id: crypto.randomUUID(),
        path: commentTarget.path,
        body: commentText.trim(),
        newLine: commentTarget.newLine,
        oldLine: commentTarget.oldLine,
      }]);
    }
    setCommentTarget(null);
    setCommentText("");
    setEditingDraftId(null);
    setReviewFeedback("");
    setReviewPanelOpen(true);
  };

  const submitReview = async () => {
    if (filesState.status !== "ready" || reviewBusy) return;
    setReviewBusy(true);
    setReviewFeedback("");
    try {
      const result = await forgeSubmitPullReview(cwd, item.number, {
        headSha: filesState.headSha,
        baseSha: filesState.baseSha,
        startSha: filesState.startSha,
        action: reviewAction,
        summary: reviewSummary.trim() || (reviewAction === "comment" ? t("forge.pr.reviewDefaultBody") : ""),
        comments: drafts,
      });
      const posted = new Set(result.postedIds);
      setDrafts((current) => current.filter((draft) => !posted.has(draft.id)));
      if (result.errors.length) {
        const message = result.postedIds.length > 0 && result.postedIds.length < drafts.length
          ? t("forge.pr.reviewPartial", { count: result.postedIds.length })
          : t("forge.pr.reviewActionFailed", { action: t(`forge.pr.reviewAction.${reviewAction}`) });
        setReviewFeedback(`${message} ${result.errors.join("; ")}`);
      } else {
        setReviewFeedback(result.actionSubmitted
          ? result.postedIds.length > 0
            ? t("forge.pr.reviewActionCompleteWithComments", { action: t(`forge.pr.reviewAction.${reviewAction}`), count: result.postedIds.length })
            : t("forge.pr.reviewActionComplete", { action: t(`forge.pr.reviewAction.${reviewAction}`) })
          : t("forge.pr.reviewActionFailed", { action: t(`forge.pr.reviewAction.${reviewAction}`) }));
        if (result.actionSubmitted) setReviewSummary("");
      }
    } catch (error) {
      setReviewFeedback(forgeErrorOf(error).message);
    } finally {
      setReviewBusy(false);
    }
  };

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      data-ade-diff-search-root
      className="flex min-h-[min(68vh,720px)] max-h-[76vh] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-white/8 dark:bg-white/2"
    >
      <div className="flex min-h-11 items-center justify-between gap-3 border-b border-gray-200 px-3 dark:border-white/8">
        <div className="min-w-0 truncate text-[12px] font-medium text-gray-700 dark:text-white/75">
          {t("forge.pr.code")}
          {filesState.status === "ready" && <span className="ml-2 text-gray-400 dark:text-white/35">{filesState.files.length}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {drafts.length > 0 && <span className="rounded-md bg-accent-50 px-2 py-1 text-[10px] text-accent-700 dark:bg-accent-400/8 dark:text-accent-300">{t("forge.pr.reviewDrafts", { count: drafts.length })}</span>}
          {filesState.status === "ready" && filesState.provider !== "other" && (
            <button
              type="button"
              onClick={openThreads}
              aria-expanded={threadsOpen}
              className="rounded-md px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-100 dark:text-white/55 dark:hover:bg-white/8"
            >{t("forge.pr.threadsButton")}{threadsStatus === "ready" && <span className="ml-1 opacity-60">{threads.length}</span>}</button>
          )}
          <button
            type="button"
            onClick={() => setReviewPanelOpen((open) => !open)}
            aria-expanded={reviewPanelOpen}
            className="rounded-md px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-100 dark:text-white/55 dark:hover:bg-white/8"
          >{t("forge.pr.reviewOpen")}</button>
          <button
            type="button"
            onClick={() => setSearchOpen((open) => !open)}
            className="rounded-md px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-100 dark:text-white/55 dark:hover:bg-white/8"
            aria-label={t("forge.pr.searchCode")}
          >
            {t("forge.pr.searchCode")} <span className="ml-1 opacity-60">{findShortcut}</span>
          </button>
        </div>
      </div>

      {searchOpen && (
        <div className="border-b border-gray-200 dark:border-white/8">
          <div className="flex items-center gap-2 px-3 py-2">
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") { setSearchOpen(false); setQuery(""); }
                if (event.key === "Enter" && hits.length) selectHit(hits[0]);
                event.stopPropagation();
              }}
              placeholder={t("forge.pr.searchPlaceholder")}
              className="min-w-0 flex-1 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] text-gray-800 outline-none focus:border-accent-500 dark:border-white/10 dark:bg-black/15 dark:text-white"
            />
            <span className="shrink-0 text-[10px] text-gray-400 dark:text-white/40">{hits.length}{hits.length === 500 ? "+" : ""}</span>
            <button type="button" onClick={() => { setSearchOpen(false); setQuery(""); }} className="rounded px-1.5 text-[11px] text-gray-500 hover:bg-gray-100 dark:text-white/55 dark:hover:bg-white/8">Esc</button>
          </div>
          {query.trim() && (
            <div className="max-h-48 overflow-auto border-t border-gray-100 dark:border-white/5">
              {searchState === "loading" && <p className="px-3 py-2 text-[11px] text-gray-400">{t("forge.pr.searchLoading")}</p>}
              {searchState === "error" && <p className="px-3 py-2 text-[11px] text-red-500">{searchError}</p>}
              {searchState === "ready" && hits.length === 0 && <p className="px-3 py-2 text-[11px] text-gray-400">{t("forge.pr.searchEmpty")}</p>}
              {hits.map((hit, index) => (
                <button
                  key={`${hit.path}:${hit.line}:${index}`}
                  type="button"
                  onClick={() => selectHit(hit)}
                  className="flex w-full min-w-0 items-start gap-2 px-3 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-white/5"
                >
                  <span className="w-8 shrink-0 text-right font-mono text-[10px] text-gray-400">{hit.line}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[10px] text-accent-600 dark:text-accent-400">{hit.path}</span>
                    <span className="block truncate font-mono text-[10px] text-gray-600 dark:text-white/65">{hit.excerpt}</span>
                  </span>
                </button>
              ))}
              {hits.length === 500 && <p className="px-3 py-2 text-[10px] text-gray-400">{t("forge.pr.searchResultCap")}</p>}
              {truncated && <p className="px-3 py-2 text-[10px] text-amber-600 dark:text-amber-400">{t("forge.pr.searchLimited")}</p>}
            </div>
          )}
        </div>
      )}

      {threadsOpen && filesState.status === "ready" && (
        <section aria-label={t("forge.pr.threadsTitle")} className="max-h-72 shrink-0 overflow-auto border-b border-gray-200 bg-gray-50/70 dark:border-white/8 dark:bg-black/10">
          <div className="sticky top-0 z-[2] flex items-center justify-between gap-3 border-b border-gray-200 bg-white/95 px-3 py-2 backdrop-blur dark:border-white/8 dark:bg-gray-950/95">
            <span className="text-[11px] font-medium text-gray-700 dark:text-white/75">{t("forge.pr.threadsTitle")}</span>
            <button type="button" disabled={threadsStatus === "loading"} onClick={() => void loadThreads()} className="rounded px-2 py-1 text-[10px] text-accent-700 hover:bg-gray-100 disabled:opacity-50 dark:text-accent-300 dark:hover:bg-white/8">{threadsStatus === "loading" ? t("forge.pr.threadsLoading") : t("forge.pr.threadsRefresh")}</button>
          </div>
          {threadsStatus === "loading" && <p className="px-3 py-3 text-[11px] text-gray-500 dark:text-white/50">{t("forge.pr.threadsLoading")}</p>}
          {threadsStatus === "error" && <p role="alert" className="px-3 py-3 text-[11px] text-red-500">{threadsError}</p>}
          {threadsError && threadsStatus === "ready" && <p role="alert" className="px-3 py-2 text-[11px] text-red-500">{threadsError}</p>}
          {threadsStatus === "ready" && threads.length === 0 && <p className="px-3 py-3 text-[11px] text-gray-500 dark:text-white/50">{t("forge.pr.threadsEmpty")}</p>}
          {threadsStatus === "ready" && threads.map((thread) => (
            <article key={thread.id} className="border-b border-gray-200 px-3 py-2 last:border-b-0 dark:border-white/8">
              <div className="flex items-start gap-2">
                <button type="button" disabled={!thread.path || !thread.line} onClick={() => openThreadLocation(thread)} className="min-w-0 flex-1 text-left text-[10px] text-accent-700 hover:underline disabled:text-gray-500 disabled:no-underline dark:text-accent-300 dark:disabled:text-white/40">
                  <span className="font-mono">{thread.path ?? t("forge.pr.threadsNoPath")}</span>
                  {thread.line && <span className="ml-1">:{thread.line}</span>}
                  {thread.outdated && <span className="ml-2 text-amber-700 dark:text-amber-300">{t("forge.pr.threadsOutdated")}</span>}
                </button>
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] ${thread.resolved ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300" : "bg-amber-100 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300"}`}>{thread.resolved ? t("forge.pr.threadsResolved") : t("forge.pr.threadsOpen")}</span>
              </div>
              <div className="mt-1.5 space-y-1.5">
                {thread.comments.map((comment) => (
                  <div key={comment.id} className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 dark:border-white/8 dark:bg-white/[0.025]">
                    <div className="mb-0.5 flex flex-wrap items-center gap-x-2 text-[9px] text-gray-500 dark:text-white/45">
                      <span className="font-medium text-gray-700 dark:text-white/70">{comment.author ?? t("forge.pr.threadsUnknownAuthor")}</span>
                      {comment.createdAt && <time>{comment.createdAt}</time>}
                    </div>
                    <p className="whitespace-pre-wrap break-words text-[10px] leading-relaxed text-gray-700 dark:text-white/70">{comment.body}</p>
                  </div>
                ))}
              </div>
              <div className="mt-1.5 flex items-end gap-2">
                {thread.canReply && (
                  <div className="flex min-w-0 flex-1 items-end gap-1.5">
                    <textarea
                      value={threadReplyDrafts[thread.id] ?? ""}
                      onChange={(event) => setThreadReplyDrafts((current) => ({ ...current, [thread.id]: event.target.value }))}
                      maxLength={8000}
                      rows={1}
                      aria-label={t("forge.pr.threadsReplyPlaceholder")}
                      placeholder={t("forge.pr.threadsReplyPlaceholder")}
                      className="min-h-7 min-w-0 flex-1 resize-y rounded-md border border-gray-200 bg-white px-2 py-1 text-[10px] text-gray-800 outline-none focus:border-accent-500 dark:border-white/10 dark:bg-black/15 dark:text-white"
                    />
                    <button type="button" disabled={!threadReplyDrafts[thread.id]?.trim() || threadBusyId !== null} onClick={() => void submitThreadReply(thread)} className="shrink-0 rounded bg-accent-600 px-2 py-1.5 text-[9px] font-medium text-white hover:bg-accent-700 disabled:opacity-50">{threadBusyId === thread.id ? t("forge.pr.threadsSending") : t("forge.pr.threadsReply")}</button>
                  </div>
                )}
                {thread.canResolve && (
                  <button type="button" disabled={threadBusyId !== null} onClick={() => void toggleThreadResolved(thread)} className="shrink-0 rounded px-2 py-1.5 text-[9px] text-gray-600 hover:bg-gray-200 disabled:opacity-50 dark:text-white/60 dark:hover:bg-white/8">{threadBusyId === thread.id ? t("forge.pr.threadsSaving") : thread.resolved ? t("forge.pr.threadsReopen") : t("forge.pr.threadsResolve")}</button>
                )}
              </div>
            </article>
          ))}
          {threadsStatus === "ready" && threadsTruncated && <p className="px-3 py-2 text-[10px] text-amber-700 dark:text-amber-300">{t("forge.pr.threadsTruncated")}</p>}
        </section>
      )}

      {filesState.status === "loading" ? (
        <p className="px-4 py-6 text-[12px] text-gray-400">{t("forge.pr.filesLoading")}</p>
      ) : filesState.status === "error" ? (
        <p className="break-words px-4 py-6 text-[12px] text-red-500">{filesState.message}</p>
      ) : filesState.files.length === 0 ? (
        <p className="px-4 py-6 text-[12px] text-gray-400">{t("forge.pr.noFiles")}</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {reviewPanelOpen && (
            <section className="shrink-0 border-b border-accent-200 bg-accent-50/70 px-3 py-2 dark:border-accent-400/15 dark:bg-accent-400/5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 text-[11px] font-medium text-gray-700 dark:text-white/75">
                  {drafts.length > 0 ? t("forge.pr.reviewDrafts", { count: drafts.length }) : t("forge.pr.reviewActionLabel")}
                </div>
                <button
                  type="button"
                  disabled={!canSubmitReview}
                  onClick={() => void submitReview()}
                  className="rounded-md bg-accent-600 px-2.5 py-1.5 text-[10px] font-medium text-white hover:bg-accent-700 disabled:opacity-50"
                >
                  {reviewBusy ? t("forge.pr.reviewSending") : t("forge.pr.reviewSubmitAction", { action: t(`forge.pr.reviewAction.${reviewAction}`) })}
                </button>
              </div>
              {reviewActions.length === 0 ? (
                <p className="mt-2 text-[10px] text-gray-500 dark:text-white/50">{t("forge.pr.reviewUnsupported")}</p>
              ) : (
                <>
                  <div role="group" aria-label={t("forge.pr.reviewActionLabel")} className="mt-2 flex flex-wrap gap-1">
                    {reviewActions.map((action) => (
                      <button
                        key={action}
                        type="button"
                        disabled={reviewBusy}
                        aria-pressed={reviewAction === action}
                        onClick={() => { setReviewAction(action); setReviewFeedback(""); }}
                        className={`rounded-md px-2 py-1 text-[10px] ${reviewAction === action ? "bg-accent-600 text-white" : "bg-white text-gray-600 hover:bg-gray-100 dark:bg-black/15 dark:text-white/60 dark:hover:bg-white/8"} disabled:opacity-50`}
                      >{t(`forge.pr.reviewAction.${action}`)}</button>
                    ))}
                  </div>
                  {filesState.provider === "gitlab" ? (
                    <p className="mt-1 text-[10px] text-gray-500 dark:text-white/50">{t("forge.pr.reviewGitlabNote")}</p>
                  ) : (
                    <textarea
                      value={reviewSummary}
                      onChange={(event) => setReviewSummary(event.target.value)}
                      maxLength={2000}
                      rows={2}
                      placeholder={t("forge.pr.reviewSummary")}
                      className="mt-2 w-full resize-y rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-[11px] text-gray-800 outline-none focus:border-accent-500 dark:border-white/10 dark:bg-black/15 dark:text-white"
                    />
                  )}
                </>
              )}
              {reviewAction === "requestChanges" && !reviewSummary.trim() && <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">{t("forge.pr.reviewSummaryRequired")}</p>}
              <div className="mt-1.5 flex max-h-20 flex-wrap gap-1 overflow-auto">
                {drafts.map((draft) => (
                  <span key={draft.id} className="inline-flex max-w-full items-center gap-1 rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[9px] text-gray-600 dark:border-white/10 dark:bg-black/15 dark:text-white/60">
                    <span className="max-w-40 truncate font-mono">{draft.path}</span>
                    <span>:{draft.newLine ?? draft.oldLine}</span>
                    <button type="button" aria-label={t("forge.pr.reviewRemoveDraft")} onClick={() => setDrafts((current) => current.filter((entry) => entry.id !== draft.id))} className="ml-0.5 px-0.5 text-gray-400 hover:text-red-500">×</button>
                  </span>
                ))}
              </div>
              {reviewFeedback && <p role="status" className="mt-1 break-words text-[10px] text-gray-600 dark:text-white/55">{reviewFeedback}</p>}
            </section>
          )}

          <div className="flex min-h-0 flex-1">
            <nav aria-label={t("forge.pr.changedFiles")} className="w-[min(38%,250px)] shrink-0 overflow-auto border-r border-gray-200 dark:border-white/8">
              {filesState.files.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => { setFileLoadError(""); setCommentTarget(null); setEditingDraftId(null); setSelectedPath(file.path); setViewMode(file.status === "removed" ? "diff" : "file"); }}
                  className={`flex w-full min-w-0 items-center gap-2 border-b border-gray-100 px-2.5 py-2 text-left dark:border-white/5 ${selectedPath === file.path ? "bg-gray-100 dark:bg-white/8" : "hover:bg-gray-50 dark:hover:bg-white/4"}`}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-gray-700 dark:text-white/75" title={file.path}>{file.path}</span>
                  <span className="shrink-0 text-[9px] text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
                  <span className="shrink-0 text-[9px] text-red-500">−{file.deletions}</span>
                </button>
              ))}
            </nav>

            <section className="flex min-w-0 flex-1 flex-col">
              <div className="flex min-h-9 items-center justify-between gap-2 border-b border-gray-200 px-3 dark:border-white/8">
                <span className="truncate font-mono text-[10px] text-gray-500 dark:text-white/55" title={selectedPath}>{selectedPath}</span>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    disabled={!selectedFile || selectedFile.status === "removed"}
                    onClick={() => setViewMode("file")}
                    className={`rounded px-1.5 py-1 text-[9px] ${viewMode === "file" ? "bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-white/80" : "text-gray-500 hover:bg-gray-50 dark:text-white/45 dark:hover:bg-white/5"} disabled:opacity-35`}
                  >{t("forge.pr.fileView")}</button>
                  <button
                    type="button"
                    disabled={!selectedFile?.patch}
                    onClick={() => { setViewMode("diff"); setCommentTarget(null); }}
                    className={`rounded px-1.5 py-1 text-[9px] ${viewMode === "diff" ? "bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-white/80" : "text-gray-500 hover:bg-gray-50 dark:text-white/45 dark:hover:bg-white/5"} disabled:opacity-35`}
                  >{t("forge.pr.diffView")}</button>
                  {selectedFile && <span className="ml-1 text-[9px] text-gray-400">{selectedFile.status}</span>}
                </div>
              </div>

              {viewMode === "diff" ? (
                selectedFile?.patch ? (
                  <div ref={codeScrollRef} className="min-h-0 flex-1 overflow-auto text-[10px] leading-5">
                    {parsedDiff.lines.map((line, index) => {
                      const target = {
                        path: selectedPath,
                        oldLine: line.kind === "removed" || line.kind === "context" ? line.oldLine : null,
                        newLine: line.kind === "added" || line.kind === "context" ? line.newLine : null,
                      };
                      const locationKey = reviewTargetKey(target.path, target.oldLine, target.newLine);
                      const targetDrafts = line.kind === "added" || line.kind === "removed"
                        ? drafts.filter((draft) => reviewTargetKey(draft.path, draft.oldLine, draft.newLine) === locationKey)
                        : [];
                      const commentable =
                        (line.kind === "added" && line.newLine !== null)
                        || (line.kind === "removed" && line.oldLine !== null)
                        || (line.kind === "context" && line.oldLine !== null && line.newLine !== null);
                      const active = commentTarget && reviewTargetKey(commentTarget.path, commentTarget.oldLine, commentTarget.newLine) === locationKey;
                      return (
                        <div key={`${selectedPath}:${index}`}>
                          <div data-old-line={line.oldLine ?? undefined} data-new-line={line.newLine ?? undefined} className={`grid min-w-max grid-cols-[3.25rem_3.25rem_1.75rem_minmax(0,1fr)] ${line.kind === "added" ? "bg-[var(--cc-diff-add-bg)]" : line.kind === "removed" ? "bg-[var(--cc-diff-del-bg)]" : line.kind === "meta" ? "bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-white/45" : ""}`}>
                            <span className="select-none pr-2 text-right font-mono text-gray-400 dark:text-white/30">{line.oldLine ?? ""}</span>
                            <span className="select-none pr-2 text-right font-mono text-gray-400 dark:text-white/30">{line.newLine ?? ""}</span>
                            {commentable ? (
                              <button
                                type="button"
                                aria-label={t("forge.pr.reviewCommentOnLine")}
                                title={t("forge.pr.reviewCommentOnLine")}
                                onClick={() => { setCommentTarget(target); setCommentText(""); setEditingDraftId(null); }}
                                className="rounded-sm text-accent-600 hover:bg-accent-100 dark:text-accent-300 dark:hover:bg-white/10"
                              >+</button>
                            ) : <span />}
                            <pre className="m-0 min-w-0 whitespace-pre px-2 font-mono text-gray-800 dark:text-white/80">{line.kind === "meta" ? line.text : `${line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}${line.text}`}</pre>
                          </div>
                          {targetDrafts.map((draft) => (
                            <div key={draft.id} className="flex items-start gap-2 border-y border-accent-200 bg-accent-50 px-12 py-1.5 dark:border-accent-400/15 dark:bg-accent-400/5">
                              <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[10px] text-gray-700 dark:text-white/70">{draft.body}</p>
                              <button type="button" onClick={() => { setCommentTarget(target); setCommentText(draft.body); setEditingDraftId(draft.id); }} className="shrink-0 text-[10px] text-accent-700 hover:underline dark:text-accent-300">{t("forge.pr.reviewEditDraft")}</button>
                              <button type="button" aria-label={t("forge.pr.reviewRemoveDraft")} onClick={() => { setDrafts((current) => current.filter((entry) => entry.id !== draft.id)); if (editingDraftId === draft.id) { setCommentTarget(null); setCommentText(""); setEditingDraftId(null); } }} className="shrink-0 text-[10px] text-gray-400 hover:text-red-500">×</button>
                            </div>
                          ))}
                          {active && (
                            <div className="border-y border-accent-200 bg-accent-50 px-12 py-2 dark:border-accent-400/15 dark:bg-accent-400/5">
                              <textarea
                                autoFocus
                                value={commentText}
                                onChange={(event) => setCommentText(event.target.value)}
                                maxLength={2000}
                                rows={3}
                                placeholder={t("forge.pr.reviewCommentPlaceholder")}
                                className="w-full resize-y rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-[11px] text-gray-800 outline-none focus:border-accent-500 dark:border-white/10 dark:bg-black/15 dark:text-white"
                              />
                              <div className="mt-1 flex justify-end gap-1.5">
                                <button type="button" onClick={() => { setCommentTarget(null); setCommentText(""); setEditingDraftId(null); }} className="rounded px-2 py-1 text-[10px] text-gray-500 hover:bg-white/70 dark:text-white/50 dark:hover:bg-white/5">{t("forge.pr.reviewCancel")}</button>
                                <button type="button" disabled={!commentText.trim()} onClick={saveDraft} className="rounded bg-accent-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-accent-700 disabled:opacity-50">{editingDraftId ? t("forge.pr.reviewSaveEdit") : t("forge.pr.reviewAddDraft")}</button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {parsedDiff.truncated && <p className="sticky bottom-0 border-t border-amber-200 bg-amber-50 px-3 py-2 text-[10px] text-amber-700 dark:border-amber-400/15 dark:bg-amber-400/5 dark:text-amber-300">{t("forge.pr.diffDisplayLimit")}</p>}
                  </div>
                ) : (
                  <p className="px-3 py-4 text-[11px] text-gray-400">{selectedFile?.patchLimited ? t("forge.pr.diffPatchLimit") : t("forge.pr.diffUnavailable")}</p>
                )
              ) : selectedFile?.status === "removed" ? (
                <p className="px-3 py-4 text-[11px] text-gray-400">{t("forge.pr.removedFile")}</p>
              ) : !selectedContent ? (
                fileLoadError ? (
                  <div className="flex items-center gap-2 px-3 py-4 text-[11px] text-red-500">
                    <span className="min-w-0 flex-1 break-words">{fileLoadError}</span>
                    <button type="button" onClick={() => { setFileLoadError(""); loadContents([selectedPath]).catch((error) => { if (!isSnapshotChange(error)) setFileLoadError(forgeErrorOf(error).message); }); }} className="shrink-0 rounded px-2 py-1 hover:bg-gray-100 dark:hover:bg-white/8">{t("forge.pr.retry")}</button>
                  </div>
                ) : <p className="px-3 py-4 text-[11px] text-gray-400">{t("forge.pr.fileLoading")}</p>
              ) : selectedContent.error ? (
                <p className="break-words px-3 py-4 text-[11px] text-amber-600 dark:text-amber-400">{selectedContent.error}</p>
              ) : (
                <div ref={codeScrollRef} className="min-h-0 flex-1 overflow-auto text-[11px] leading-5">
                  <div className="grid min-w-max grid-cols-[auto_auto]">
                    {showLineNumbers && <pre aria-hidden="true" className="sticky left-0 z-[1] m-0 min-w-10 select-none border-r border-gray-200 bg-gray-50 px-2 text-right font-mono text-gray-400 dark:border-white/8 dark:bg-gray-900 dark:text-white/30">{lineNumbers}</pre>}
                    <pre className="m-0 min-w-0 px-3 font-mono text-gray-800 dark:text-white/80">{code}</pre>
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
