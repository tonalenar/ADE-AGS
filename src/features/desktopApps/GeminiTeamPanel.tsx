import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { canvasActions, flushSave, useActiveBoardKey, useCanvasStore } from "@/features/canvas/store";
import { useTabsStore } from "@/features/tabs/store";
import { screenOf } from "@/features/terminal/terminalRegistry";
import { comparablePath } from "@/features/tabs/viewTabs";

export function GeminiTeamPanel({ cwd }: { cwd: string }) {
  const { t } = useTranslation();
  const key = useActiveBoardKey();
  const board = useCanvasStore((s) => key ? s.boards[key] : undefined);
  const tabs = useTabsStore((s) => s.tabs);
  const node = Object.entries(board?.portals ?? {}).find(([, p]) => p.kind === "gemini");
  const [target, setTarget] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  if (!node || !key || !board) return <p className="text-xs">{t("geminiDesktop.addCanvasFirst")}</p>;
  const [id] = node;
  const candidates = tabs.filter((tab) => tab.id in board.nodes || comparablePath(tab.cwd) === comparablePath(cwd));
  const connected = board.edges.some((e) => (e.a === id && e.b === target) || (e.b === id && e.a === target));
  const send = async () => {
    setBusy(true); setMessage("");
    try {
      await flushSave(key);
      await invoke("gemini_desktop_peer_send", { from: id, to: target, text });
      setMessage(t("geminiDesktop.sentToPeer")); setText("");
    } catch (e) { setMessage(String(e)); }
    finally { setBusy(false); }
  };
  return <section className="flex flex-col gap-2 border-b border-gray-300 pb-3 dark:border-white/15" aria-label={t("geminiDesktop.team")}>
    <strong className="text-sm">{t("geminiDesktop.team")}</strong>
    <p className="text-xs text-gray-500">{t("geminiDesktop.teamHint")}</p>
    <select aria-label={t("geminiDesktop.peer")} className="rounded border bg-white p-1 text-xs dark:bg-surface" value={target} onChange={(e) => { setTarget(e.target.value); setMessage(""); }}>
      <option value="">{t("geminiDesktop.peer")}</option>
      {candidates.map((tab) => <option key={tab.id} value={tab.id}>{tab.title || tab.agentLabel}</option>)}
    </select>
    <button className="rounded border px-2 py-1 text-xs disabled:opacity-40" disabled={!target || busy} onClick={() => connected ? canvasActions.disconnectPair(key, id, target) : canvasActions.connect(key,id,target)}>
      {t(connected ? "canvas.disconnect" : "geminiDesktop.linkPeer")}
    </button>
    <button className="rounded border px-2 py-1 text-xs disabled:opacity-40" disabled={!target || !connected} onClick={() => {
      const lines = screenOf(target)?.lines.join("\n");
      if (!lines) { setMessage(t("geminiDesktop.noPeerOutput")); return; }
      void navigator.clipboard.writeText(lines).then(() => setMessage(t("geminiDesktop.outputCopied"))).catch((e) => setMessage(String(e)));
    }}>{t("geminiDesktop.copyPeerOutput")}</button>
    <textarea aria-label={t("geminiDesktop.peerMessage")} className="rounded border bg-transparent p-2 text-xs" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("geminiDesktop.peerMessage")} />
    <button className="rounded border px-2 py-1 text-xs disabled:opacity-40" disabled={!connected || !text.trim() || busy} onClick={() => void send()}>{t("geminiDesktop.sendToPeer")}</button>
    {message && <p role="status" className="break-words text-xs">{message}</p>}
  </section>;
}
