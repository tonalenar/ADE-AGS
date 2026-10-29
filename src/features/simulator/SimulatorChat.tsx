import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { simulatorScreenshot, simulatorTell } from "./ipc";
import { addLine, useSimulatorStore, type SimLine } from "./store";

export interface SimAgent {
  id: string;
  name: string;
  agentId: string;
}

/** A cor do avatar de cada agente: a da marca, pelos tokens do tema. */
function avatarTone(agentId: string): string {
  if (agentId.startsWith("claude")) return "bg-orange-500";
  if (agentId.startsWith("codex")) return "bg-emerald-600";
  if (agentId.startsWith("gemini") || agentId.startsWith("antigravity")) return "bg-accent-500";
  if (agentId.startsWith("cursor")) return "bg-violet-600";
  return "bg-gray-600";
}

function Avatar({ name, agentId }: { name: string; agentId: string }) {
  return (
    <span aria-hidden className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] text-[10px] font-bold text-white ${avatarTone(agentId)}`}>
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

function time(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Line({ line, agents }: { line: SimLine; agents: SimAgent[] }) {
  const { t } = useTranslation();
  if (line.kind === "user") {
    return (
      <div className="self-end max-w-[85%] rounded-[12px_12px_4px_12px] bg-accent-600 px-2.5 py-1.5 text-[12px] text-white">
        <div className="whitespace-pre-wrap break-words">{line.text}</div>
        {line.shot && <div className="mt-0.5 text-[10.5px] opacity-75">📎 {t("simulator.chat.attached")}</div>}
      </div>
    );
  }
  if (line.kind === "system") {
    return <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-2.5 py-2 text-[11.5px] text-red-200">{line.text}</div>;
  }
  const agent = agents.find((a) => a.name === line.agent);
  if (line.kind === "action") {
    return (
      <div className="flex items-center gap-1.5 pl-[26px] text-[11px] text-gray-400">
        <span aria-hidden>↳</span>
        <span className="truncate">{line.agent}</span>
        <code className="rounded bg-white/5 px-1.5 py-px font-mono text-[10.5px] text-gray-300">{line.text}</code>
      </div>
    );
  }
  return (
    <div className="flex gap-2 text-[12px] leading-[1.45]">
      <Avatar name={line.agent} agentId={agent?.agentId ?? ""} />
      <div className="min-w-0 flex-1">
        <span className="text-[11.5px] font-semibold text-gray-100">{line.agent}</span>
        <span className="ml-1.5 text-[10.5px] text-gray-500">{time(line.at)}</span>
        <div className="whitespace-pre-wrap break-words text-gray-200">{line.text}</div>
      </div>
    </div>
  );
}

/**
 * A conversa do simulador: o que a pessoa escreve vai para todos os agentes ligados a ele (com a tela atual, se
 * quiser); o que eles fazem no aparelho e respondem (`ags device say`) aparece aqui.
 */
export function SimulatorChat({ boardKey, node, name, udid, booted, agents, onClose }: {
  boardKey: string;
  node: string;
  name: string;
  udid: string | undefined;
  booted: boolean;
  agents: SimAgent[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const lines = useSimulatorStore((s) => s.lines[node]) ?? [];
  const [text, setText] = useState("");
  const [attach, setAttach] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const feed = useRef<HTMLDivElement>(null);

  useEffect(() => {
    feed.current?.scrollTo({ top: feed.current.scrollHeight });
  }, [lines.length]);

  const send = async () => {
    const message = text.trim();
    if (!message || sending || agents.length === 0) return;
    setSending(true);
    setError(null);
    try {
      const shot = attach && booted && udid ? await simulatorScreenshot(udid).catch(() => null) : null;
      await simulatorTell(boardKey, node, name, message, shot);
      addLine(node, { kind: "user", agent: "", text: message, at: Date.now(), shot: shot ?? undefined });
      setText("");
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="nodrag nowheel flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-surface/94 backdrop-blur-xl
      ring-1 ring-white/10 shadow-[0_24px_60px_rgba(0,0,0,0.55)] text-gray-100">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-white/7 pl-3 pr-2">
        <span className="text-[12.5px] font-semibold">{t("simulator.chat.title")}</span>
        <span className="truncate text-[11px] text-gray-400">· {t("simulator.chat.subtitle")}</span>
        <button type="button" onClick={onClose} title={t("simulator.chat.close")} aria-label={t("simulator.chat.close")}
          className="cc-t ml-auto flex h-6 w-6 items-center justify-center rounded-md text-gray-400 hover:bg-white/8 hover:text-white">✕</button>
      </div>
      <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-white/7 px-2.5 py-2">
        {agents.length === 0 && <span className="text-[11.5px] text-gray-400">{t("simulator.chat.noAgents")}</span>}
        {agents.map((a) => (
          <span key={a.id} className="flex h-[26px] items-center gap-1.5 rounded-[7px] border border-white/8 bg-white/4 pl-1 pr-1.5 text-[11.5px]">
            <Avatar name={a.name} agentId={a.agentId} />
            <span className="max-w-32 truncate">{a.name}</span>
            <span className="rounded-[5px] bg-accent-500/15 px-1.5 text-[10.5px] text-accent-200">{t("simulator.chat.controls")}</span>
          </span>
        ))}
      </div>
      <div ref={feed} className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-2.5">
        {lines.length === 0 && <div className="m-auto max-w-64 text-center text-[11.5px] leading-snug text-gray-500">{t("simulator.chat.empty")}</div>}
        {lines.map((line) => <Line key={line.id} line={line} agents={agents} />)}
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-t border-white/7 px-2.5 py-2.5">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder={t("simulator.chat.placeholder")}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          className="min-h-[50px] resize-none rounded-[9px] border border-white/10 bg-surface-deep px-2.5 py-2 text-[12px] text-gray-100 outline-none
            placeholder:text-gray-500 focus:border-accent-500" />
        {error && <div className="text-[11px] text-red-300">{error}</div>}
        <div className="flex items-center gap-2 whitespace-nowrap text-[11px] text-gray-300">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={attach} disabled={!booted} onChange={(e) => setAttach(e.target.checked)} className="accent-accent-500" />
            {t("simulator.chat.attach")}
          </label>
          <button type="button" onClick={() => void send()} disabled={sending || !text.trim() || agents.length === 0}
            className="cc-t ml-auto h-[26px] rounded-[7px] bg-accent-600 px-3 text-[12px] font-medium text-white hover:bg-accent-500 disabled:opacity-40">
            {t("simulator.chat.send", { count: agents.length })}
          </button>
        </div>
      </div>
    </div>
  );
}
