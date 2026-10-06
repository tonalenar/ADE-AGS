import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import type { Artboard, ArtboardStatus } from "./designApi";
import { DESIGN_SANDBOX, buildSrcdoc, parsePick } from "./srcdoc";

const CHIP: Record<ArtboardStatus, string> = {
  draft: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  approved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  rejected: "bg-red-500/15 text-red-700 dark:text-red-300",
};

export const designBtn = `cc-t h-7 px-2.5 rounded-md text-[11.5px] font-medium text-gray-600 dark:text-gray-300
  hover:bg-gray-100 dark:hover:bg-white/8 disabled:opacity-40`;

export function StatusChip({ status }: { status: ArtboardStatus }) {
  const { t } = useTranslation();
  return <span className={`px-1.5 h-[18px] leading-[18px] rounded-full text-[10px] font-semibold ${CHIP[status]}`}>{t(`canvas.design.status.${status}`)}</span>;
}

/**
 * Uma prancheta: cabeçalho (título, status, versão, comentários, ações) e o HTML do agente num iframe
 * sandbox (ver `srcdoc.ts`). `live=false` não monta o iframe (fora da tela ou ainda na fila de
 * renderização): fica um bloco do mesmo tamanho, que não custa nada. `dragHandle` marca o cabeçalho como
 * a alça de arrastar quando a prancheta é um nó do canvas.
 */
export function BoardCard({ board, active, comments, live = true, dragHandle = false, onEdit, onApprove, onReject, onChoose }: {
  board: Artboard; active: boolean; comments: number; live?: boolean; dragHandle?: boolean;
  onEdit: () => void; onApprove: () => void; onReject: () => void;
  onChoose: (pick: { selector: string; text: string }) => void;
}) {
  const { t } = useTranslation();
  const [choosing, setChoosing] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const srcDoc = useMemo(() => (live ? buildSrcdoc(board.html, { chooser: choosing }) : ""), [live, board.html, choosing]);
  // Só se aceita a escolha vinda do iframe desta prancheta (o conteúdo é hostil).
  useEffect(() => {
    if (!choosing) return;
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const pick = parsePick(e.data);
      if (!pick) return;
      setChoosing(false);
      onChoose(pick);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [choosing, onChoose]);
  const size = { width: board.width, height: board.height };
  return (
    <div style={{ width: board.width }}>
      <div className={`flex items-center gap-1.5 h-7 text-[12px] ${dragHandle ? "ade-node-drag cursor-grab active:cursor-grabbing" : ""}`}>
        <span className="truncate font-medium text-gray-700 dark:text-gray-200">{board.title}</span>
        <StatusChip status={board.status} />
        <span className="text-[10px] text-gray-400">v{board.version}</span>
        {comments > 0 && <span className="text-[10px] text-accent-600 dark:text-accent-300">💬 {comments}</span>}
        <span className="flex-1" />
        <Button variant="custom" className={`nodrag ${designBtn} ${choosing ? "bg-orange-500/20 text-orange-600 dark:text-orange-300" : ""}`} onClick={() => setChoosing((v) => !v)}>
          {choosing ? t("canvas.design.choosing") : t("canvas.design.choose")}
        </Button>
        <Button variant="custom" className={`nodrag ${designBtn} ${active ? "bg-accent-500/15 text-accent-600 dark:text-accent-300" : ""}`} onClick={onEdit}>{t("canvas.design.edit")}</Button>
        <Button variant="custom" className={`nodrag ${designBtn}`} disabled={board.status === "approved"} onClick={onApprove}>{t("canvas.design.approve")}</Button>
        <Button variant="custom" className={`nodrag ${designBtn}`} disabled={board.status === "rejected"} onClick={onReject}>{t("canvas.design.reject")}</Button>
      </div>
      {live ? (
        // No canvas, o iframe só recebe o mouse ao escolher: senão engoliria o zoom e o arrastar.
        <iframe ref={frame} title={board.title} sandbox={DESIGN_SANDBOX} srcDoc={srcDoc} referrerPolicy="no-referrer"
          className={`block bg-white rounded-sm shadow-md border-0 ${board.status === "rejected" ? "opacity-50" : ""} ${dragHandle && !choosing ? "pointer-events-none" : ""}`}
          style={size} />
      ) : (
        <div className="bg-white/70 dark:bg-white/5 rounded-sm shadow-md flex items-center justify-center text-[12px] text-gray-400" style={size}>{board.title}</div>
      )}
    </div>
  );
}
