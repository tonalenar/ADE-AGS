import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertaToast, Button, CloseIcon } from "neogestify-ui-components";

import { chooseOnBoard } from "./chooseProposal";
import { BoardCard, designBtn as btn } from "./BoardCard";
import { buildTasks } from "./buildTasks";
import { allApproved, buildable, formatQueueForAgent, pendingComments } from "./commentQueue";
import { designApi, type Artboard, type ArtboardVersion, type DesignDetail } from "./designApi";
import { useMissionIndex } from "@/features/missions/groups";
import { useTabsStore } from "@/features/tabs/store";
import { spreadOverlapping } from "./layout";
import { defaultDesignId, resolveOwner } from "./owner";
import { DESIGN_SANDBOX, buildSrcdoc, parsePick } from "./srcdoc";
import { INITIAL_VIEWPORT, fitViewport, viewportReducer, zoomPercent } from "./viewport";

/**
 * O canvas de Design: as pranchetas que o agente desenhou, para ver, comentar, editar e
 * aprovar ANTES de construir. O HTML é hostil: só roda em iframe sandbox (ver `srcdoc.ts`).
 */
export function DesignPanel({ details, reload, initial, onClose }: {
  /** Os designs deste canvas (já filtrados por missão/pasta) e como recarregá-los. */
  details: DesignDetail[];
  reload: () => void | Promise<void>;
  /** O design a abrir (e a prancheta a editar), quando se chega por um aviso ou pelo botão EDITAR de um nó. */
  initial?: { designId?: string; editBoardId?: string } | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const designs = useMemo(() => details.map((d) => d.design), [details]);
  const [designId, setDesignId] = useState<string | null>(initial?.designId ?? null);
  // As abas abertas e a missão de cada uma: sem dono gravado (ou com a aba fechada) as mensagens vão à orquestradora da missão.
  const allTabs = useTabsStore((s) => s.tabs);
  const missionIndex = useMissionIndex();
  const ownerTabs = useMemo(() => allTabs.map((tab) => ({ id: tab.id, title: tab.title })), [allTabs]);
  const ownerOf = (design: { ownerTabId: string | null; missionId: string | null }) => resolveOwner(design, ownerTabs, missionIndex);
  const [pageId, setPageId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(initial?.editBoardId ?? null);
  const [vp, dispatch] = useReducer(viewportReducer, INITIAL_VIEWPORT);
  const surface = useRef<HTMLDivElement>(null);
  const fail = useCallback((e: unknown) => AlertaToast(t("canvas.design.title"), String(e), "error", 6000), [t]);

  // O design em foco: o escolhido; se sumiu (excluído) ou ainda não há escolha, o mais recente com dono.
  const currentId = designId && designs.some((d) => d.id === designId) ? designId : defaultDesignId(designs, ownerTabs, missionIndex);
  const detail = details.find((d) => d.design.id === currentId) ?? null;
  const loadDetail = useCallback(() => { void reload(); }, [reload]);

  const pages = detail?.pages ?? [];
  const page = pages.find((p) => p.id === pageId) ?? pages[0] ?? null;
  const boards = useMemo(() => spreadOverlapping((detail?.artboards ?? []).filter((a) => a.pageId === page?.id)), [detail, page]);
  const editBoard = boards.find((b) => b.id === editing) ?? null;
  const approvedCount = buildable(detail?.artboards ?? []).length;
  const queue = useMemo(() => pendingComments(detail?.comments ?? []), [detail]);

  const fit = useCallback(() => {
    const el = surface.current;
    if (!el) return;
    dispatch({ type: "set", viewport: fitViewport(boards.map((b) => ({ x: b.x, y: b.y, w: b.width, h: b.height + 28 })), el.clientWidth, el.clientHeight) });
  }, [boards]);
  // Ao trocar de design ou página, enquadra tudo.
  useEffect(() => { fit(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [currentId, page?.id]);

  // Pan: arrastar o fundo. Zoom: roda do mouse em torno do cursor.
  const drag = useRef<{ x: number; y: number } | null>(null);
  const onWheel = (e: React.WheelEvent) => {
    const r = surface.current?.getBoundingClientRect();
    if (!r) return;
    dispatch({ type: "zoomBy", factor: e.deltaY < 0 ? 1.1 : 1 / 1.1, cx: e.clientX - r.left, cy: e.clientY - r.top });
  };
  const centerZoom = (factor: number) => {
    const el = surface.current;
    if (el) dispatch({ type: "zoomBy", factor, cx: el.clientWidth / 2, cy: el.clientHeight / 2 });
  };

  const [confirmDelete, setConfirmDelete] = useState(false);
  const archive = (id: string) => {
    setEditing(null);
    designApi.archive(id).then(() => { setDesignId(null); setPageId(null); loadDetail(); }).catch(fail);
  };
  const remove = (id: string) => {
    setConfirmDelete(false);
    setEditing(null);
    designApi.remove(id).then(() => { setDesignId(null); setPageId(null); loadDetail(); }).catch(fail);
  };
  const run = (p: Promise<unknown>) => p.then(loadDetail).catch(fail);
  const choose = (board: Artboard, pick: { selector: string; text: string }) => {
    if (!detail) return;
    return chooseOnBoard({ t, board, design: detail.design, owner: ownerOf(detail.design), pick, reload });
  };
  const sendQueue = async () => {
    if (!detail || queue.length === 0) return;
    const owner = ownerOf(detail.design);
    if (!owner) return fail(t("canvas.design.noOwner"));
    try {
      await designApi.tellOwner(owner, formatQueueForAgent(detail.design.title, detail.artboards, queue));
      AlertaToast(t("canvas.design.title"), t("canvas.design.sent", { count: queue.length }), "success", 3000);
    } catch (e) {
      fail(e);
    }
  };
  const build = async () => {
    if (!detail) return;
    const owner = ownerOf(detail.design);
    if (!owner) return fail(t("canvas.design.noOwner"));
    try {
      // Só as aprovadas viram tarefa; cada uma segue ao dono, que a constrói no seu worktree.
      const tasks = buildTasks({ ...detail.design, pages: detail.pages.map((pg) => ({ ...pg, artboards: detail.artboards.filter((a) => a.pageId === pg.id) })) });
      for (const task of tasks) await designApi.tellOwner(owner, task.prompt);
      AlertaToast(t("canvas.design.title"), t("canvas.design.built", { count: tasks.length }), "success", 4000);
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="pointer-events-auto absolute inset-3 bottom-16 flex flex-col rounded-lg border border-gray-200 dark:border-white/10
      bg-white/98 dark:bg-surface-raised/98 shadow-xl overflow-hidden">
      <div className="flex items-center gap-2 px-3 h-10 shrink-0 border-b border-gray-200 dark:border-white/10">
        <span className="text-[12.5px] font-semibold text-gray-800 dark:text-gray-100">{t("canvas.design.title")}</span>
        {designs.length > 0 && (
          <select value={currentId ?? ""} onChange={(e) => { setDesignId(e.target.value); setPageId(null); setEditing(null); }}
            aria-label={t("canvas.design.pick")}
            className="h-7 max-w-[14rem] rounded-md border border-gray-200 dark:border-white/10 bg-transparent px-1.5 text-[12px]">
            {designs.map((d) => <option key={d.id} value={d.id}>{ownerOf(d) ? d.title : `${d.title} (${t("canvas.design.noOwnerTag")})`}</option>)}
          </select>
        )}
        {pages.length > 0 && (
          <select value={page?.id ?? ""} onChange={(e) => { setPageId(e.target.value); setEditing(null); }}
            aria-label={t("canvas.design.page")}
            className="h-7 rounded-md border border-gray-200 dark:border-white/10 bg-transparent px-1.5 text-[12px]">
            {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <span className="flex-1" />
        {detail && (
          <>
            <OwnerChip owner={ownerTabs.find((o) => o.id === ownerOf(detail.design))?.title ?? null} />
            <span className="text-[11px] text-gray-500 dark:text-gray-400">{t("canvas.design.approvedOf", { a: approvedCount, n: detail.artboards.length })}</span>
            <Button variant="custom" className={btn} disabled={queue.length === 0} onClick={sendQueue} title={t("canvas.design.sendHint")}>
              {t("canvas.design.sendQueue", { count: queue.length })}
            </Button>
            <Button variant="custom" className={btn} disabled={allApproved(detail.artboards)}
              onClick={() => run(designApi.approveAll(detail.design.id))}>{t("canvas.design.approveAll")}</Button>
            <Button variant="custom" className={`${btn} bg-accent-500/15 text-accent-600 dark:text-accent-300`} disabled={approvedCount === 0}
              onClick={build} title={t("canvas.design.buildHint")}>{t("canvas.design.build")}</Button>
          </>
        )}
        {detail && (
          <Button variant="custom" className={btn} onClick={() => archive(detail.design.id)} title={t("canvas.design.archiveHint")}>{t("canvas.design.archive")}</Button>
        )}
        {detail && (
          <Button variant="custom" className={`${btn} ${confirmDelete ? "bg-red-500/15 text-red-600 dark:text-red-300" : ""}`}
            onClick={() => (confirmDelete ? remove(detail.design.id) : setConfirmDelete(true))} onBlur={() => setConfirmDelete(false)}
            title={t("canvas.design.deleteHint")}>
            {confirmDelete ? t("canvas.design.deleteConfirm") : t("canvas.design.delete")}
          </Button>
        )}
        <Button variant="custom" onClick={onClose} aria-label={t("canvas.design.close")}
          className="cc-t w-7 h-7 flex items-center justify-center rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
          <CloseIcon className="w-3 h-3" />
        </Button>
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="relative flex-1 min-w-0 overflow-hidden bg-gray-100 dark:bg-black/30 cursor-grab active:cursor-grabbing select-none"
          ref={surface} onWheel={onWheel}
          onPointerDown={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.world) { drag.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId); } }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            dispatch({ type: "pan", dx: e.clientX - drag.current.x, dy: e.clientY - drag.current.y });
            drag.current = { x: e.clientX, y: e.clientY };
          }}
          onPointerUp={() => { drag.current = null; }}>
          {boards.length === 0 && (
            <p className="absolute inset-0 flex items-center justify-center px-8 text-center text-[12.5px] text-gray-500 dark:text-gray-400">
              {designs.length === 0 ? t("canvas.design.empty") : t("canvas.design.emptyPage")}
            </p>
          )}
          <div data-world="1" className="absolute left-0 top-0 origin-top-left"
            style={{ transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` }}>
            {boards.map((b) => (
              <div key={b.id} className="absolute" style={{ left: b.x, top: b.y }}>
                <BoardCard board={b} active={editing === b.id}
                  comments={(detail?.comments ?? []).filter((c) => c.artboardId === b.id && !c.resolved).length}
                  onEdit={() => setEditing(editing === b.id ? null : b.id)}
                  onApprove={() => run(designApi.approve(b.id))} onReject={() => run(designApi.reject(b.id))}
                  onChoose={(pick) => choose(b, pick)} />
              </div>
            ))}
          </div>

          <div className="absolute left-3 bottom-3 flex items-center rounded-full border shadow bg-white/95 dark:bg-surface-raised/95
            border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300">
            <Button variant="custom" onClick={() => centerZoom(1 / 1.2)} aria-label={t("canvas.zoomOut")} className="cc-t w-8 h-8">−</Button>
            <Button variant="custom" onClick={fit} title={t("canvas.fit")} className="cc-t w-12 h-8 text-[12px] font-semibold tabular-nums">{zoomPercent(vp)}</Button>
            <Button variant="custom" onClick={() => centerZoom(1.2)} aria-label={t("canvas.zoomIn")} className="cc-t w-8 h-8">+</Button>
          </div>
        </div>

        {editBoard && detail && (
          <EditPane key={editBoard.id} board={editBoard} onClose={() => setEditing(null)} onChanged={loadDetail} fail={fail}
            versions={detail.versions[editBoard.id] ?? []}
            comments={detail.comments.filter((c) => c.artboardId === editBoard.id)} />
        )}
      </div>
    </div>
  );
}

function EditPane({ board, versions, comments, onClose, onChanged, fail }: {
  board: Artboard;
  versions: ArtboardVersion[];
  comments: DesignDetailComments;
  onClose: () => void;
  onChanged: () => void;
  fail: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(board.html);
  const [selector, setSelector] = useState<{ selector: string; text: string } | null>(null);
  const [text, setText] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  // O HTML mudou no servidor (o agente atualizou) e o rascunho local não foi tocado: acompanha.
  const base = useRef(board.html);
  useEffect(() => {
    if (draft === base.current) setDraft(board.html);
    base.current = board.html;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.html, board.version, board.id]);

  // Só se aceita mensagem do iframe desta prancheta.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const pick = parsePick(e.data);
      if (pick) setSelector(pick);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const preview = useMemo(() => buildSrcdoc(draft, { picker: true }), [draft]);
  const dirty = draft !== board.html;
  const act = (p: Promise<unknown>) => p.then(onChanged).catch(fail);
  const addComment = () => {
    const body = text.trim();
    if (!body) return;
    act(designApi.addComment(board.id, body, selector?.selector ?? null));
    setText("");
    setSelector(null);
  };
  const previous = versions.filter((v) => v.version < board.version).sort((a, b) => b.version - a.version)[0];

  return (
    <aside className="w-[26rem] shrink-0 flex flex-col border-l border-gray-200 dark:border-white/10 min-h-0">
      <div className="flex items-center gap-1 px-3 h-9 shrink-0 border-b border-gray-200 dark:border-white/10">
        <span className="truncate text-[12px] font-semibold">{t("canvas.design.editing", { title: board.title })}</span>
        <span className="flex-1" />
        <Button variant="custom" className={btn} disabled={!previous} onClick={() => previous && act(designApi.revert(board.id, previous.version, board.version))}
          title={t("canvas.design.undoHint")}>{t("canvas.design.undo")}</Button>
        <Button variant="custom" className={`${btn} bg-accent-500/15 text-accent-600 dark:text-accent-300`} disabled={!dirty}
          onClick={() => act(designApi.updateArtboard(board.id, { html: draft, expectedVersion: board.version }))}>{t("canvas.design.save")}</Button>
        <Button variant="custom" onClick={onClose} aria-label={t("canvas.design.close")} className="cc-t w-6 h-6 flex items-center justify-center text-gray-400">
          <CloseIcon className="w-3 h-3" />
        </Button>
      </div>
      <div className="overflow-y-auto flex-1 p-3 space-y-3">
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} aria-label={t("canvas.design.source")}
          className="w-full h-40 resize-y rounded-md border border-gray-200 dark:border-white/10 bg-transparent p-2 font-mono text-[11px]" />
        <div>
          <div className="mb-1 text-[10.5px] text-gray-500">{t("canvas.design.preview")} — {t("canvas.design.pickHint")}</div>
          <div className="overflow-hidden rounded border border-gray-200 dark:border-white/10 bg-white"
            style={{ height: Math.min(260, board.height * (360 / board.width)) }}>
            <iframe ref={frame} title={t("canvas.design.preview")} sandbox={DESIGN_SANDBOX} srcDoc={preview} referrerPolicy="no-referrer"
              className="border-0 origin-top-left"
              style={{ width: board.width, height: board.height, transform: `scale(${360 / board.width})` }} />
          </div>
        </div>
        <div className="space-y-1.5">
          {selector && (
            <div className="flex items-center gap-1 text-[10.5px] text-accent-600 dark:text-accent-300">
              <code className="truncate" title={selector.selector}>{selector.selector}</code>
              <Button variant="custom" onClick={() => setSelector(null)} aria-label={t("canvas.design.clearPick")} className="cc-t w-4 h-4"><CloseIcon className="w-2.5 h-2.5" /></Button>
            </div>
          )}
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={t("canvas.design.commentPlaceholder")}
            className="w-full h-14 resize-none rounded-md border border-gray-200 dark:border-white/10 bg-transparent p-2 text-[12px]" />
          <Button variant="custom" className={btn} disabled={!text.trim()} onClick={addComment}>{t("canvas.design.addComment")}</Button>
        </div>
        <ul className="space-y-1">
          {comments.map((c) => (
            <li key={c.id} className={`rounded-md border border-gray-100 dark:border-white/6 px-2 py-1 text-[11.5px] ${c.resolved ? "opacity-50" : ""}`}>
              <div className="flex items-center gap-1 text-[10px] text-gray-400">
                <span>{c.author === "user" ? t("canvas.design.you") : t("canvas.design.agent")}</span>
                {c.selector && <code className="truncate max-w-[10rem]" title={c.selector}>{c.selector}</code>}
                <span className="flex-1" />
                <Button variant="custom" className="cc-t text-[10px] hover:underline" onClick={() => act(designApi.resolveComment(c.id, !c.resolved))}>
                  {c.resolved ? t("canvas.design.reopen") : t("canvas.design.resolve")}
                </Button>
              </div>
              {c.text}
            </li>
          ))}
        </ul>
        {versions.length > 0 && (
          <div>
            <div className="mb-1 text-[10.5px] text-gray-500">{t("canvas.design.versions")}</div>
            <ul className="space-y-0.5">
              {[...versions].sort((a, b) => b.version - a.version).map((v) => (
                <li key={v.version} className="flex items-center gap-2 text-[11px] text-gray-600 dark:text-gray-300">
                  <span>v{v.version}{v.version === board.version ? ` · ${t("canvas.design.current")}` : ""}</span>
                  <span className="flex-1" />
                  {v.version !== board.version && (
                    <Button variant="custom" className="cc-t text-[10.5px] hover:underline" onClick={() => act(designApi.revert(board.id, v.version, board.version))}>
                      {t("canvas.design.restore")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </aside>
  );
}

type DesignDetailComments = DesignDetail["comments"];

/** Quem é o dono do design (recebe os comentários); sem dono, avisa que eles não chegam a ninguém. */
function OwnerChip({ owner }: { owner: string | null }) {
  const { t } = useTranslation();
  return owner
    ? <span className="max-w-[10rem] truncate text-[11px] text-gray-500 dark:text-gray-400" title={t("canvas.design.ownerHint")}>{t("canvas.design.owner", { name: owner })}</span>
    : <span className="px-1.5 h-[18px] leading-[18px] rounded-full bg-red-500/15 text-red-700 dark:text-red-300 text-[10px] font-semibold" title={t("canvas.design.noOwner")}>{t("canvas.design.noOwnerBadge")}</span>;
}
