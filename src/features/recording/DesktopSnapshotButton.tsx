import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { MAX_PENDING_CAPTURES, rememberPendingCapture } from "@/features/chat/attachments/pendingCaptures";
import { attachToComposer } from "@/features/chat/store";
import { CameraIcon } from "@/features/chat/chatIcons";
import { usePopover } from "@/features/chat/usePopover";
import { AlertaToast } from "@/shared/ui/alerts";

import { desktopScreenshot, desktopSnapshotTargets } from "./ipc";
import {
  MAIN_TARGET,
  SNAPSHOT_DEFAULT_EVENT,
  parseTargetValue,
  reconcileTarget,
  stepIndex,
  targetOptions,
  targetValue,
  windowLabel,
  type SnapshotListing,
  type SnapshotTarget,
  type TargetOption,
} from "./snapshotTargets";

/** A última escolha do menu, guardada na sessão: o id de uma janela não sobrevive a reiniciar o app. */
const LAST_CHOICE_KEY = "cc-snapshot-ultima-escolha";

/** Lê a última escolha. Valor que não é de nenhum alvo, ou storage indisponível, viram a tela principal. */
function readLastChoice(): SnapshotTarget {
  try {
    return parseTargetValue(sessionStorage.getItem(LAST_CHOICE_KEY) ?? "") ?? MAIN_TARGET;
  } catch {
    return MAIN_TARGET;
  }
}

function writeLastChoice(target: SnapshotTarget): void {
  try {
    sessionStorage.setItem(LAST_CHOICE_KEY, targetValue(target));
  } catch {
    /* sem storage, o menu abre na tela principal, como numa sessão nova */
  }
}

const ITEM_CLASS = "w-full min-h-7 flex items-center gap-2 px-2 rounded-md text-left text-chat-ui text-gray-900 dark:text-white hover:bg-gray-100 focus:bg-gray-100 focus:outline-none dark:hover:bg-white/[0.07] dark:focus:bg-white/[0.07] disabled:opacity-40 disabled:pointer-events-none";
/** Cabeçalho de grupo ("Telas", "Janelas"): em negrito, como o rótulo de seção do menu da câmera. */
const GROUP_CLASS = "px-2 pt-1.5 pb-0.5 text-chat-caption font-medium text-gray-500 dark:text-white/45";
/** Aviso que não é um alvo (carregando, falhou, sem janelas): texto comum, sem competir com os itens. */
const NOTE_CLASS = "px-2 py-1 text-chat-caption text-gray-500 dark:text-white/45";

/**
 * O botão de câmera do composer. Um clique abre o menu de alvos ancorado nele: a tela principal primeiro, depois as
 * outras telas e as janelas. Escolher um item captura esse alvo e põe a imagem no rascunho atual; o menu fecha antes da
 * captura, para a foto não pegar o próprio menu.
 *
 * Ao abrir, o foco vai para a última escolha, se ela ainda existir, e senão para a tela principal. Setas andam pelos
 * itens habilitados, Enter escolhe o item em foco, Esc fecha sem capturar e devolve o foco à câmera.
 *
 * O atalho `Cmd+Shift+S` pede a captura da tela principal direto, sem abrir o menu. Antes de anexar, a captura fica
 * guardada como pendente: ela sobrevive a trocar de conversa ou recarregar até ser enviada.
 */
export function DesktopSnapshotButton({ className = "", target = null, disabled = false }: { className?: string; target?: string | null; disabled?: boolean }) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover<HTMLDivElement>();
  const [busy, setBusy] = useState(false);
  const [listing, setListing] = useState<SnapshotListing | null>(null);
  const [failed, setFailed] = useState(false);
  const reading = useRef(false);
  // Se a pessoa já andou com as setas, a chegada da lista não devolve o foco à última escolha.
  const movedByKeys = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const macOS = typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent);

  // A lista é lida ao abrir o menu, e não ao montar o composer: cada leitura roda o helper do macOS.
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

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  // Ao abrir, o foco vai para a última escolha (se ela ainda existe e pode ser capturada) ou para a tela principal.
  // Enquanto a lista não chega, a escolha ainda não está no menu: quando ela chega, o foco é ajustado de novo.
  useEffect(() => {
    if (!open || movedByKeys.current) return;
    const preferred = targetValue(reconcileTarget(readLastChoice(), listing));
    const menu = menuRef.current;
    const node = menu?.querySelector<HTMLElement>(`[data-snapshot-value="${preferred}"]`)
      ?? menu?.querySelector<HTMLElement>('[data-snapshot-value="main"]');
    node?.focus();
  }, [open, listing]);

  const capture = async (requested: SnapshotTarget) => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      const path = await desktopScreenshot(requested);
      const { dropped } = rememberPendingCapture({ path, target, kind: "snapshot" });
      attachToComposer([path], target);
      void AlertaToast(t("screenRecording.snapshot"), t("screenRecording.snapshotDone"), "success", 3000);
      if (dropped) void AlertaToast(t("screenRecording.snapshot"), t("screenRecording.pendingDropped", { max: MAX_PENDING_CAPTURES }), "warning", 6000);
    } catch (error) {
      void AlertaToast(t("screenRecording.snapshot"), String(error), "error", 5000);
    } finally {
      setBusy(false);
    }
  };

  const choose = (picked: SnapshotTarget) => {
    setOpen(false);
    writeLastChoice(picked);
    void capture(picked);
  };

  // O atalho chega por evento no mesmo botão: a captura é a mesma, só o alvo é sempre a tela principal.
  const captureRef = useRef(capture);
  captureRef.current = capture;
  useEffect(() => {
    const button = buttonRef.current;
    if (!button) return undefined;
    const onDefault = () => {
      setOpen(false);
      void captureRef.current(MAIN_TARGET);
    };
    button.addEventListener(SNAPSHOT_DEFAULT_EVENT, onDefault);
    return () => button.removeEventListener(SNAPSHOT_DEFAULT_EVENT, onDefault);
  }, [macOS, setOpen]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // Se não parar aqui, o Esc segue até o que estiver por baixo do menu.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    movedByKeys.current = true;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []).filter((item) => !item.disabled);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : stepIndex(current, items.length, event.key === "ArrowDown" ? 1 : -1);
    items[next]?.focus();
  };

  const onItemKeyDown = (event: KeyboardEvent<HTMLButtonElement>, picked: SnapshotTarget) => {
    if (event.key !== "Enter") return;
    // Enter escolhe; sem o preventDefault, o navegador ainda mandaria um clique a mais.
    event.preventDefault();
    choose(picked);
  };

  if (!macOS) return null;

  const options = targetOptions(listing);
  const displays = options.filter((option) => option.group === "display" && option.value !== "main");
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

  const item = (picked: SnapshotTarget, label: string, itemDisabled: boolean) => (
    <button key={targetValue(picked)} type="button" role="menuitem" data-snapshot-value={targetValue(picked)}
      disabled={itemDisabled} title={label} className={ITEM_CLASS}
      onClick={() => choose(picked)} onKeyDown={(event) => onItemKeyDown(event, picked)}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );

  const title = t("screenRecording.snapshotMenu");
  return (
    <div ref={ref} className="relative shrink-0">
      <button ref={buttonRef} type="button" className={className} disabled={busy || disabled} title={title} aria-label={title}
        aria-haspopup="menu" aria-expanded={open} data-chat-desktop-snapshot=""
        onClick={() => {
          movedByKeys.current = false;
          setOpen(!open);
        }}>
        <CameraIcon className="w-4 h-4" />
        <span className="sr-only">{t("screenRecording.snapshot")}</span>
      </button>
      {open && (
        <div ref={menuRef} role="menu" aria-label={t("screenRecording.targetLabel")} onKeyDown={onMenuKeyDown}
          className="absolute left-0 bottom-full mb-1.5 z-50 w-72 max-h-[min(22rem,70vh)] overflow-y-auto p-1 rounded-lg bg-white/[0.92] dark:bg-surface-raised/[0.92] backdrop-blur-xl
            shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_16px_40px_-18px_rgba(0,0,0,0.55)]">
          {item(MAIN_TARGET, t("screenRecording.targetMain"), false)}
          {listing === null && !failed && <p role="none" className={NOTE_CLASS}>{t("screenRecording.targetsLoading")}</p>}
          {failed && <p role="none" className={NOTE_CLASS}>{t("screenRecording.listFailed")}</p>}
          {displays.length > 0 && (
            <div role="group" aria-labelledby={`${menuId}-telas`}>
              <div id={`${menuId}-telas`} role="none" className={GROUP_CLASS}>{t("screenRecording.groupDisplays")}</div>
              {displays.map((option) => item(option.target, displayText(option), option.disabled))}
            </div>
          )}
          {listing !== null && (
            <div role="group" aria-labelledby={`${menuId}-janelas`}>
              {/* Sem permissão, o próprio cabeçalho diz o que falta para escolher janelas. */}
              <div id={`${menuId}-janelas`} role="none" className={GROUP_CLASS}>
                {noPermission ? t("screenRecording.groupWindowsNoPermission") : t("screenRecording.groupWindows")}
              </div>
              {windows.map((option) => item(option.target, option.window ? windowLabel(option.window) : "", option.disabled))}
              {windows.length === 0 && <p role="none" className={NOTE_CLASS}>{t("screenRecording.noWindows")}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
