import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { StopIcon } from "../chatIcons";
import type { TimelineItem } from "../timeline/types";
import { chatTaskOutput, type TaskOutput } from "./ipc";
import { ArrowLeftIcon } from "./taskIcons";
import { elapsedMs, formatElapsed, type BgTask } from "./tasksModel";
import { STATUS_TONE, stopLabel } from "./taskView";

/** De quanto em quanto ler a saída de um shell que roda (o `get_task_output` do Claude: só leitura, sem turno). */
export const OUTPUT_POLL_MS = 2_000;

/** A saída de um shell do Claude: lida já, e de novo enquanto ele roda; uma última vez quando acaba. */
function useShellOutput(task: BgTask, threadId: string | null): { output: TaskOutput | null; error: string | null } {
  const [output, setOutput] = useState<TaskOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const readable = task.kind === "shell" && task.source === "events" && task.stoppable && !!threadId;
  const running = task.status === "running";
  useEffect(() => {
    if (!readable || !threadId) return;
    let alive = true;
    const read = () => chatTaskOutput(threadId, task.id).then((o) => { if (alive) { setOutput(o); setError(null); } }, (e) => { if (alive) setError(String(e)); });
    void read();
    if (!running) return () => { alive = false; };
    const id = setInterval(() => { void read(); }, OUTPUT_POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [readable, running, threadId, task.id]);
  return { output, error: readable ? error : null };
}

/**
 * O detalhe de uma tarefa (o chevron da linha): o pedido, a saída do shell ou o que o subagente fez enquanto chega, e
 * o resultado. A seta volta à lista (Esc também); o parar fica enquanto ela roda.
 */
export function TaskDetail({ task, threadId, transcript, now, onBack, onStop }: {
  task: BgTask; threadId: string | null; transcript: TimelineItem[] | null; now: number; onBack: () => void; onStop: () => void;
}) {
  const { t } = useTranslation();
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { backRef.current?.focus(); }, [task.id]);
  const { output, error } = useShellOutput(task, threadId);
  const title = task.title || t("chat.tasks.untitled");
  const isRunning = task.status === "running";
  const stop = stopLabel(task, threadId, t);
  const time = formatElapsed(elapsedMs(task, now), t);
  const kind = task.subagent ? `${t(`chat.tasks.kind.${task.kind}`)} · ${task.subagent}` : t(`chat.tasks.kind.${task.kind}`);
  const shell = task.kind === "shell";
  return (
    <div className="flex-1 min-h-0 flex flex-col" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onBack(); } }}>
      <div className="shrink-0 flex items-center gap-1.5 px-2 pb-2 border-b border-gray-200 dark:border-white/[0.08]">
        <button ref={backRef} type="button" onClick={onBack} aria-label={t("chat.tasks.back")} title={t("chat.tasks.back")}
          className="w-7 h-7 shrink-0 flex items-center justify-center rounded-md text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500">
          <ArrowLeftIcon className="w-[15px] h-[15px]" />
        </button>
        <div className="flex-1 min-w-0 flex flex-col">
          <h3 className="m-0 truncate text-chat-ui font-medium text-gray-900 dark:text-white" title={title}>{title}</h3>
          <p className="m-0 flex items-center gap-1.5 text-chat-caption text-gray-500 dark:text-white/45">
            <span className="truncate">{kind}</span>
            <span aria-hidden="true">·</span>
            <span className={STATUS_TONE[task.status]}>{t(`chat.tasks.status.${task.status}`)}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{time}</span>
          </p>
        </div>
        {isRunning && (
          <button type="button" disabled={!stop.enabled} aria-disabled={!stop.enabled} onClick={onStop} aria-label={stop.label} title={stop.label}
            className="w-7 h-7 shrink-0 flex items-center justify-center rounded-md border border-gray-200 dark:border-white/10 text-gray-600 dark:text-white/60 hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500">
            <StopIcon className="w-2.5 h-2.5" />
          </button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-3.5 py-3 flex flex-col gap-3 text-chat-note" aria-live="polite" aria-busy={isRunning}>
        {task.prompt && (
          <Block label={t("chat.tasks.prompt")}>
            <p className="m-0 whitespace-pre-wrap break-words text-gray-800 dark:text-white/80">{task.prompt}</p>
          </Block>
        )}
        {shell && (
          <Block label={t("chat.tasks.output")}>
            {output && output.output ? (
              <>
                {output.truncated && <p className="m-0 mb-1 text-chat-caption text-gray-500 dark:text-white/45">{t("chat.tasks.outputTruncated")}</p>}
                <pre className="m-0 p-2.5 rounded-lg bg-gray-50 dark:bg-black/40 font-mono text-chat-caption whitespace-pre-wrap break-all text-gray-800 dark:text-white/80">{output.output}</pre>
              </>
            ) : (
              <p className="m-0 text-gray-500 dark:text-white/45">{error ?? (task.source === "events" && task.stoppable ? t("chat.tasks.outputEmpty") : t("chat.tasks.outputUnavailable"))}</p>
            )}
          </Block>
        )}
        {!shell && task.kind === "agent" && (
          <Block label={t("chat.tasks.transcript")}>
            {transcript && transcript.length > 0 ? <Transcript items={transcript} />
              : <p className="m-0 text-gray-500 dark:text-white/45">{task.source === "events" && !isRunning ? t("chat.tasks.transcriptGone") : task.source === "events" ? t("chat.tasks.transcriptEmpty") : t("chat.tasks.transcriptNone")}</p>}
          </Block>
        )}
        {task.lastTool && isRunning && <p className="m-0 text-chat-caption text-gray-500 dark:text-white/45">{t("chat.tasks.lastTool", { tool: task.lastTool })}</p>}
        {task.summary && (
          <Block label={isRunning ? t("chat.tasks.progress") : t("chat.tasks.result")}>
            <p className="m-0 whitespace-pre-wrap break-words text-gray-800 dark:text-white/80">{task.summary}</p>
          </Block>
        )}
        {task.status === "lost" && <p className="m-0 text-chat-caption text-gray-500 dark:text-white/45">{t("chat.tasks.lostNote")}</p>}
      </div>
    </div>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h4 className="m-0 text-chat-caption font-medium text-gray-500 dark:text-white/45">{label}</h4>
      {children}
    </section>
  );
}

const TOOL_TONE: Record<string, string> = {
  running: "bg-accent-500 motion-safe:animate-pulse", done: "bg-emerald-500", error: "bg-red-500", denied: "bg-gray-400",
};

/** O que o subagente fez: o texto dele e cada ferramenta (nome, o que ela tocou, o status). */
function Transcript({ items }: { items: TimelineItem[] }) {
  return (
    <ol className="list-none m-0 p-0 flex flex-col gap-1.5">
      {items.filter((i) => i.kind === "assistant" || i.kind === "tool").map((item) => (
        <li key={item.id}>
          {item.kind === "assistant" ? (
            <p className="m-0 whitespace-pre-wrap break-words text-gray-800 dark:text-white/80">{item.text}</p>
          ) : (
            <p className="m-0 flex items-center gap-1.5 min-w-0 text-chat-caption text-gray-600 dark:text-white/60">
              <span aria-hidden="true" className={`w-1.5 h-1.5 shrink-0 rounded-full ${TOOL_TONE[item.status ?? "done"] ?? "bg-gray-400"}`} />
              <span className="font-medium text-gray-800 dark:text-white/80">{item.name}</span>
              {(item.label ?? item.path) && <span className="truncate font-mono" title={item.label ?? item.path}>{item.label ?? item.path}</span>}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
