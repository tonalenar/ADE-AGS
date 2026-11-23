import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";

import { chatTeamQueue, chatTeamQueueCancel } from "./ipc";
import { parseQueue, type QueueRow } from "./lineageModel";
import { useStructured } from "../structured/store";
import { threadStatusSignature } from "../structured/model";
import type { BusEvent } from "@/shared/bus";

/**
 * A fila de tarefas do time de um orquestrador, com o motivo de cada espera. O backend a relê e lança sozinho;
 * aqui só se lê de novo quando algo muda (a fase das conversas ou o aviso `queue` do barramento), nunca por relógio.
 */
export function useTeamQueue(threadId: string): QueueRow[] {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [tick, setTick] = useState(0);
  const signature = useStructured((s) => threadStatusSignature(s.live, [threadId]));
  useEffect(() => {
    const unlisten = listen<BusEvent>("ade-event", (e) => {
      if (e.payload.topic === "chat.changed" && e.payload.data?.type === "queue") setTick((n) => n + 1);
    });
    return () => { unlisten.then((off) => off()).catch(() => undefined); };
  }, []);
  useEffect(() => {
    let alive = true;
    chatTeamQueue(`thread:${threadId}`).then((raw) => { if (alive) setRows(parseQueue(raw).rows); }).catch(() => undefined);
    return () => { alive = false; };
  }, [threadId, signature, tick]);
  return rows;
}

/** "Fila do time · N aguardando": cada tarefa com o que a segura e o botão de cancelar. Some sem tarefa esperando. */
export function TeamQueuePanel({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  const rows = useTeamQueue(threadId);
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const shown = useMemo(() => rows.filter((r) => !gone.has(r.id)), [rows, gone]);
  if (shown.length === 0) return null;
  return (
    <section aria-label={t("chat.queue.panel")} className="rounded-xl border border-gray-200 dark:border-white/[0.08] px-3 py-2 text-chat-note">
      <div className="text-chat-caption text-gray-500 dark:text-white/45">{t("chat.queue.title", { count: shown.length })}</div>
      <ul className="m-0 p-0 list-none flex flex-col">
        {shown.map((row) => (
          <li key={row.id} className="flex items-start gap-2 py-1 min-w-0">
            <div className="flex-1 min-w-0">
              <div className="truncate text-gray-900 dark:text-white" title={row.title}>{row.title}</div>
              <div className="text-chat-caption text-gray-500 dark:text-white/45">
                {row.waitingOn.length > 0 ? row.waitingOn.join(" · ") : t("chat.queue.ready")}
              </div>
              {row.areas.length > 0 && <div className="truncate text-chat-caption text-gray-500 dark:text-white/45" title={row.areas.join(", ")}>{t("chat.queue.areas", { areas: row.areas.join(", ") })}</div>}
            </div>
            <button type="button" onClick={() => { setGone((g) => new Set(g).add(row.id)); chatTeamQueueCancel(row.id).catch(() => setGone((g) => { const n = new Set(g); n.delete(row.id); return n; })); }}
              className="shrink-0 font-medium text-gray-900 dark:text-white hover:underline">{t("chat.queue.cancel")}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
