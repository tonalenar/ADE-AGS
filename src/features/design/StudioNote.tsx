import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { noteBg, noteMaxHeight } from "./studioModel";

export interface StudioNoteItem { id: string; x: number; y: number; w: number; h: number; text: string; color: string | null }

/**
 * Uma nota (sticky) no canvas: arrasta pelo corpo, duplo clique edita o texto (salva ao sair), cresce
 * até 4/3 da largura e depois rola.
 */
export const StudioNote = memo(function StudioNote({ note, selected, onDown, onSave, onContext }: {
  note: StudioNoteItem;
  selected: boolean;
  onDown: (e: React.PointerEvent, id: string) => void;
  onSave: (id: string, text: string) => void;
  onContext: (e: React.MouseEvent, id: string) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => { if (!note.text && editing === null) setEditing(""); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- nota nova já abre em edição
  const commit = () => {
    if (editing !== null && editing !== note.text) onSave(note.id, editing);
    setEditing(null);
  };
  return (
    <div data-note={note.id}
      className={`absolute rounded-md shadow-[0_2px_4px_rgba(24,24,27,0.07),0_6px_16px_rgba(24,24,27,0.08)] ${noteBg(note.color)}
        ${selected ? "ring-2 ring-accent-500" : ""} ${editing === null ? "cursor-grab active:cursor-grabbing" : ""}`}
      style={{ left: note.x, top: note.y, width: note.w, minHeight: note.h, maxHeight: noteMaxHeight(note.w) }}
      onPointerDown={(e) => { if (editing === null) onDown(e, note.id); }}
      onDoubleClick={() => setEditing(note.text)}
      onContextMenu={(e) => onContext(e, note.id)}>
      {editing !== null ? (
        <textarea autoFocus value={editing} aria-label={t("design.studio.noteText")}
          onChange={(e) => setEditing(e.target.value)} onBlur={commit}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") setEditing(null); }}
          className="block w-full resize-none bg-transparent p-3 text-[14px] leading-snug text-gray-900 outline-none"
          style={{ minHeight: note.h, maxHeight: noteMaxHeight(note.w) }} />
      ) : (
        <div className="p-3 text-[14px] leading-snug text-gray-900 whitespace-pre-wrap break-words overflow-auto select-none"
          style={{ maxHeight: noteMaxHeight(note.w) }}>
          {note.text || <span className="text-gray-500">{t("design.studio.notePlaceholder")}</span>}
        </div>
      )}
    </div>
  );
});
