import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { designApi, onDesignChanged, type Design } from "@/features/canvas/design/designApi";
import { designsForBoard } from "@/features/canvas/design/scope";
import { DesignStudio, OpenFullButton } from "@/features/design/DesignStudio";
import { PopupSelect } from "@/shared/ui/PopupSelect";

import { useChatStore } from "./store";

/**
 * A aba "Design" do painel direito: a tela de Design (a mesma da rota `/design/:id`) com os designs da
 * pasta da conversa. Com mais de um, um seletor na barra; `ags design open` escolhe pelo store.
 */
export function DesignPane({ cwd }: { cwd: string | null }) {
  const { t } = useTranslation();
  const [designs, setDesigns] = useState<Design[] | null>(null);
  const request = useChatStore((s) => s.designOpen);
  const [chosen, setChosen] = useState<string | null>(request?.designId ?? null);

  const load = useCallback(async () => {
    try {
      setDesigns(designsForBoard(await designApi.list(), { cwd, missionId: null }));
    } catch {
      setDesigns([]);
    }
  }, [cwd]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => onDesignChanged(() => { void load(); }), [load]);
  useEffect(() => { if (request) setChosen(request.designId); }, [request?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  // O pedido pode ser de um design de outra pasta (aberto pelo CLI): ele entra na lista.
  const list = useMemo(() => {
    const base = designs ?? [];
    return request && !base.some((d) => d.id === request.designId) ? [...base, { id: request.designId, title: request.designId } as Design] : base;
  }, [designs, request]);
  const current = list.find((d) => d.id === chosen)?.id ?? list[list.length - 1]?.id ?? null;

  if (designs === null) return <p className="p-4 text-chat-note text-gray-400 dark:text-white/40">{t("chat.panel.loading")}</p>;
  if (!current) return <p className="p-4 text-chat-note leading-snug text-gray-400 dark:text-white/40">{t("chat.design.empty")}</p>;

  const picker = list.length > 1 ? (
    <PopupSelect value={current} onChange={(e) => setChosen(e.target.value)} aria-label={t("canvas.design.pick")} className="max-w-[12rem]">
      {list.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
    </PopupSelect>
  ) : null;
  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <DesignStudio key={current} designId={current} host="chat"
        request={request && request.designId === current ? request : null}
        leading={picker}
        trailing={<OpenFullButton label={t("design.studio.openFull")} onClick={() => { window.location.hash = `#/design/${encodeURIComponent(current)}`; }} />} />
    </div>
  );
}
