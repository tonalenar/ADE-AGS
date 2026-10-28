import { memo, useState } from "react";
import { Position, NodeResizer } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import type { CanvasPortal } from "@/features/canvas/board";
import { canvasActions, useActiveBoardKey, useCanvasStore } from "@/features/canvas/store";
import { CordPort } from "@/features/canvas/cords";
import { RoleEditDialog } from "@/features/canvas/RoleEditDialog";
import { useCanvasRoles, roleLabelOf } from "@/features/canvas/agentRole";
import { useViewTabsStore } from "@/features/tabs/viewStore";

export const GeminiDesktopNode = memo(function GeminiDesktopNode({ id, cwd, portal, selected }: {
  id: string; cwd: string; portal: CanvasPortal; selected: boolean;
}) {
  const { t } = useTranslation();
  const boardKey = useActiveBoardKey();
  const orchestrator = useCanvasStore((s) => !!boardKey && !!s.boards[boardKey]?.orchestrators.includes(id));
  const role = useCanvasStore((s) => boardKey ? s.boards[boardKey]?.roles[id] ?? "" : "");
  const [editing, setEditing] = useState(false);
  const roles = useCanvasRoles();
  const subagent = useCanvasStore((s) => !!boardKey && !!s.boards[boardKey]?.subagents.includes(id));
  const port = "w-2.5! h-2.5! border-2! border-white! bg-blue-500!";
  return <div className={`flex h-full flex-col rounded-lg border bg-white dark:bg-surface ${selected ? "border-blue-500" : "border-blue-500/30"}`}>
    <NodeResizer isVisible={true} handleStyle={{width:12,height:12,borderRadius:3}} lineStyle={{borderWidth:3}} minWidth={360} minHeight={320} />
    <CordPort id="l" type="source" position={Position.Left} className={port} />
    <CordPort id="r" type="source" position={Position.Right} className={port} />
    <CordPort id="t" type="source" position={Position.Top} className={port} />
    <CordPort id="b" type="source" position={Position.Bottom} className={port} />
    <div style={{ height: 34 }} className="ade-node-drag flex shrink-0 items-center gap-2 border-b border-blue-500/20 px-2 text-sm">
      <span className="text-blue-500" aria-hidden="true">✦</span><strong className="flex-1">{portal.name}</strong>

      <button className="nodrag px-1" aria-pressed={orchestrator} title={t(orchestrator ? "canvas.orchestratorOff" : "canvas.orchestratorOn")} onClick={() => { if (boardKey) canvasActions.toggleOrchestrator(boardKey,id); }}>{orchestrator ? "♛" : "♕"}</button>
      <button className="nodrag rounded px-1" aria-label={t("role.editTitle")} title={role || t("role.editTitle")} onClick={() => setEditing(true)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m16 3 5 5L8 21H3v-5Z" /></svg></button>
      <button className="nodrag rounded px-2" aria-label={t("btn.close")} onClick={() => { if (boardKey) canvasActions.removePortal(boardKey, id); }}>×</button>
    </div>
    {editing && <RoleEditDialog name={portal.name} label={role} subagent={subagent} tunable={false}
      tab={{id, cwd, title:portal.name, agentId:"gemini-desktop", agentLabel:"Gemini Desktop", command:"", ptyId:null, openedAt:0}}
      onClose={() => setEditing(false)} onSave={(choice) => { if (boardKey) canvasActions.setRole(boardKey,id,roleLabelOf(roles,choice.roleId),choice.subagent); }} />}
    <div className="nodrag flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
      <p className="text-xs text-gray-500">{t("geminiDesktop.canvasHint")}</p>
      <button className="rounded-md border border-blue-500/30 px-3 py-2 text-xs" onClick={() => useViewTabsStore.getState().openGemini(cwd)}>{t("geminiDesktop.openPanel")}</button>
    </div>
  </div>;
});
