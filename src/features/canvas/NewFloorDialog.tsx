import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "neogestify-ui-components";

import { AppDialog } from "@/shared/ui/AppDialog";

import { defaultStart, filterBranches, parseExcluded, type BranchInfo } from "./floorsModel";

export interface CreatedFloor {
  id: string;
  name: string;
  branch: string;
  cwd: string;
}

type Mode = "new" | "existing";

const field = "w-full h-8 px-2 rounded-md text-[12.5px] outline-none bg-white dark:bg-white/8 border border-gray-300 dark:border-white/15 focus:border-accent-400 text-gray-800 dark:text-gray-100";

/**
 * "Novo andar": o nome, de onde a branch nasce (uma nova a partir de outra, ou uma que já existe e não está em
 * uso em outro andar) e as pastas que ficam de fora da cópia. Quem chama recebe o andar criado.
 */
export function NewFloorDialog({ cwd, onClose, onCreated }: {
  cwd: string;
  onClose: () => void;
  onCreated: (floor: CreatedFloor) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<Mode>("new");
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [from, setFrom] = useState("");
  const [existing, setExisting] = useState("");
  const [query, setQuery] = useState("");
  const [excluded, setExcluded] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    invoke<BranchInfo[]>("floor_branches", { cwd })
      .then((list) => {
        if (!alive) return;
        setBranches(list);
        setFrom((cur) => cur || defaultStart(list));
      })
      .catch((e) => alive && (setBranches([]), setError(String(e))));
    return () => { alive = false; };
  }, [cwd]);

  const shown = useMemo(() => filterBranches(branches ?? [], query), [branches, query]);
  const ready = name.trim().length > 0 && (mode === "new" || existing !== "") && !busy;

  const create = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const floor = await invoke<CreatedFloor>("floor_create", {
        cwd,
        name: name.trim(),
        from: mode === "new" ? from || null : null,
        existingBranch: mode === "existing" ? existing : null,
        exclude: parseExcluded(excluded),
      });
      onCreated(floor);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const radio = (value: Mode, label: string) => (
    <label className="flex items-center gap-1.5 text-[12.5px] text-gray-700 dark:text-gray-200 cursor-pointer">
      <input type="radio" name="floor-mode" className="accent-accent-500" checked={mode === value} onChange={() => setMode(value)} />
      {label}
    </label>
  );

  return (
    <AppDialog title={t("canvas.floor.new.title")} size="md" closeOnEsc onClose={() => !busy && onClose()}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t("btn.cancel")}</Button>
          <Button variant="primary" disabled={!ready} onClick={() => void create()}>
            {busy ? t("canvas.floor.new.creating") : t("canvas.floor.new.create")}
          </Button>
        </>
      )}>
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-gray-600 dark:text-gray-300">{t("canvas.floor.name")}</span>
          <input autoFocus className={field} value={name} maxLength={40} disabled={busy}
            placeholder={t("canvas.floor.namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void create(); }} />
        </label>

        <fieldset className="flex flex-col gap-2" disabled={busy}>
          <legend className="text-[12px] font-medium text-gray-600 dark:text-gray-300 mb-1">{t("canvas.floor.new.branch")}</legend>
          <div className="flex gap-4">
            {radio("new", t("canvas.floor.new.modeNew"))}
            {radio("existing", t("canvas.floor.new.modeExisting"))}
          </div>
          {mode === "new" ? (
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] text-gray-500 dark:text-gray-400">{t("canvas.floor.new.from")}</span>
              <select className={field} value={from} onChange={(e) => setFrom(e.target.value)}>
                {(branches ?? []).map((b) => <option key={b.name} value={b.name}>{b.name}{b.current ? ` (${t("canvas.floor.new.current")})` : ""}</option>)}
                {branches?.length === 0 && <option value="">HEAD</option>}
              </select>
            </label>
          ) : (
            <div className="flex flex-col gap-1.5">
              <input className={field} value={query} placeholder={t("canvas.floor.new.search")} onChange={(e) => setQuery(e.target.value)} />
              <ul className="max-h-40 overflow-auto rounded-md border border-gray-200 dark:border-white/10 cc-scroll" role="listbox" aria-label={t("canvas.floor.new.modeExisting")}>
                {shown.length === 0 && <li className="px-2 py-2 text-[12px] text-gray-400">{t("canvas.floor.new.noBranch")}</li>}
                {shown.map((b) => (
                  <li key={b.name} role="option" aria-selected={existing === b.name} aria-disabled={b.inUse}>
                    <button type="button" disabled={b.inUse} onClick={() => setExisting(b.name)} title={b.inUse ? t("canvas.floor.new.inUse") : b.name}
                      className={`w-full text-left px-2 py-1 text-[12.5px] truncate disabled:opacity-40 disabled:cursor-not-allowed
                        ${existing === b.name ? "bg-accent-500/15 text-accent-600 dark:text-accent-300" : "hover:bg-gray-100 dark:hover:bg-white/6"}`}>
                      {b.name}
                      {b.current && <span className="ml-1.5 text-[10.5px] text-gray-400">{t("canvas.floor.new.current")}</span>}
                      {b.inUse && <span className="ml-1.5 text-[10.5px] text-amber-500">{t("canvas.floor.new.inUseTag")}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </fieldset>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-gray-600 dark:text-gray-300">{t("canvas.floor.new.exclude")}</span>
          <textarea className={`${field} h-16 py-1.5 resize-none`} value={excluded} disabled={busy}
            placeholder="node_modules, target, dist" onChange={(e) => setExcluded(e.target.value)} />
          <span className="text-[11px] text-gray-400">{t("canvas.floor.new.excludeHint")}</span>
        </label>

        {error && <p role="alert" className="text-[12px] text-red-500 whitespace-pre-wrap">{error}</p>}
      </div>
    </AppDialog>
  );
}
