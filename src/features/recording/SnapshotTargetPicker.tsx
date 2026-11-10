import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { PopupSelect } from "@/shared/ui/PopupSelect";

import { desktopSnapshotTargets } from "./ipc";
import {
  parseTargetValue,
  reconcileTarget,
  targetOptions,
  targetValue,
  windowLabel,
  type SnapshotListing,
  type SnapshotTarget,
  type TargetOption,
} from "./snapshotTargets";

/**
 * Seletor compacto ao lado da câmera: escolhe o que o SnapShot captura. O padrão é a tela principal, e o atalho
 * `Cmd+Shift+S` sempre pede esse padrão. A lista de telas e janelas é lida ao encostar no seletor, e não quando o
 * composer abre, para não rodar o helper do macOS a cada conversa aberta.
 */
export function SnapshotTargetPicker({ value, onChange, disabled = false, className = "" }: {
  value: SnapshotTarget;
  onChange: (target: SnapshotTarget) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [listing, setListing] = useState<SnapshotListing | null>(null);
  const [failed, setFailed] = useState(false);
  const reading = useRef(false);

  const refresh = useCallback(() => {
    if (reading.current) return;
    reading.current = true;
    desktopSnapshotTargets()
      .then((next) => {
        setListing(next);
        setFailed(false);
      })
      .catch(() => setFailed(true))
      .finally(() => {
        reading.current = false;
      });
  }, []);

  // O menu é um portal: o React propaga o ponteiro dele até aqui. Só o gesto que começa no seletor lê a lista.
  const onEnter = (event: { currentTarget: HTMLElement; target: EventTarget }) => {
    if (event.currentTarget.contains(event.target as Node)) refresh();
  };

  // Janela que sumiu ou ficou bloqueada numa leitura nova: a escolha volta para a tela principal.
  useEffect(() => {
    const next = reconcileTarget(value, listing);
    if (targetValue(next) !== targetValue(value)) onChange(next);
  }, [listing, value, onChange]);

  const options = targetOptions(listing);
  const displays = options.filter((option) => option.group === "display");
  const windows = options.filter((option) => option.group === "window");
  const noPermission = listing !== null && !listing.titles;

  const displayText = (option: TargetOption): string => {
    const display = option.display;
    if (!display || display.main) return t("screenRecording.targetMain");
    const name = display.number === null
      ? t("screenRecording.targetOther")
      : t("screenRecording.targetDisplay", { number: display.number });
    if (option.blocked === "permission") return `${name} (${t("screenRecording.blockedPermission")})`;
    if (option.blocked === "numbering") return `${name} (${t("screenRecording.blockedNumbering")})`;
    return name;
  };

  return (
    <span className={`inline-flex min-w-0 shrink-0 items-center ${className}`} onPointerDownCapture={onEnter} onFocusCapture={onEnter}>
      <PopupSelect
        aria-label={t("screenRecording.targetLabel")}
        title={t("screenRecording.targetLabel")}
        value={targetValue(value)}
        disabled={disabled}
        onChange={(event) => {
          const picked = parseTargetValue(event.target.value);
          if (picked) onChange(picked);
        }}
        className="h-7 max-w-[9rem] rounded-md px-1.5 text-chat-caption text-gray-600 hover:bg-gray-100 dark:text-white/60 dark:hover:bg-white/10"
      >
        <optgroup label={t("screenRecording.groupDisplays")}>
          {displays.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>{displayText(option)}</option>
          ))}
        </optgroup>
        {listing === null && !failed && <option value="loading" disabled>{t("screenRecording.targetsLoading")}</option>}
        {failed && <option value="failed" disabled>{t("screenRecording.listFailed")}</option>}
        {listing !== null && (
          <optgroup label={noPermission ? t("screenRecording.groupWindowsNoPermission") : t("screenRecording.groupWindows")}>
            {windows.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>{option.window ? windowLabel(option.window) : ""}</option>
            ))}
            {windows.length === 0 && <option value="no-windows" disabled>{t("screenRecording.noWindows")}</option>}
          </optgroup>
        )}
      </PopupSelect>
    </span>
  );
}
