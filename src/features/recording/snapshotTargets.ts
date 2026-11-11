/**
 * Alvos do SnapShot do Mac (tela principal, outra tela e janela): o modelo puro do menu da câmera e da legenda.
 *
 * Espelha `computer_use::snapshot` (Rust). Só entram ids, nomes de app e títulos de janela, que o macOS entrega
 * com a Gravação de Tela autorizada; nenhum pixel passa por aqui.
 */

/** Disparado no botão de captura quando o atalho `Cmd+Shift+S` pede a captura padrão (tela principal). */
export const SNAPSHOT_DEFAULT_EVENT = "cc-desktop-snapshot-default";

/** Prefixo do arquivo que o SnapShot grava (`PREFIX` em `computer_use/snapshot.rs`). */
export const SNAPSHOT_FILE_PREFIX = "ADE-AGS_SnapShot_";

export type SnapshotTarget = { kind: "main" } | { kind: "display"; id: number } | { kind: "window"; id: number };

export const MAIN_TARGET: SnapshotTarget = { kind: "main" };

export type SnapshotBlocked = "permission" | "numbering";

export interface SnapshotDisplay {
  id: number;
  main: boolean;
  /** O número do `screencapture -D`; `null` quando o macOS não o documenta para esta tela. */
  number: number | null;
  pixelWidth: number;
  pixelHeight: number;
  pointsWidth: number;
  pointsHeight: number;
  capturable: boolean;
  blocked: SnapshotBlocked | null;
}

export interface SnapshotWindow {
  id: number;
  app: string;
  /** Só existe com a Gravação de Tela autorizada. */
  title: string | null;
  capturable: boolean;
}

export interface SnapshotListing {
  titles: boolean;
  displays: SnapshotDisplay[];
  windows: SnapshotWindow[];
}

/** O JSON ao lado de cada PNG do SnapShot (`SnapshotInfo` em `computer_use/snapshot.rs`). */
export interface SnapshotInfo {
  version: number;
  scope: "display" | "window";
  app: string | null;
  title: string | null;
  displayNumber: number | null;
  capturedAt: string;
}

export interface TargetOption {
  value: string;
  target: SnapshotTarget;
  group: "display" | "window";
  disabled: boolean;
  blocked: SnapshotBlocked | null;
  display: SnapshotDisplay | null;
  window: SnapshotWindow | null;
}

export type SnapshotCaption =
  | { kind: "main" }
  | { kind: "display"; number: number }
  | { kind: "window"; app: string; title: string | null };

/** O valor de cada item do menu: `main`, `display:<id>` ou `window:<id>`. */
export function targetValue(target: SnapshotTarget): string {
  return target.kind === "main" ? "main" : `${target.kind}:${target.id}`;
}

/** O inverso de `targetValue`. Valor que não é de nenhum alvo vira nada. Pura. */
export function parseTargetValue(value: string): SnapshotTarget | null {
  if (value === "main") return MAIN_TARGET;
  const match = /^(display|window):(\d+)$/.exec(value);
  if (!match) return null;
  const id = Number(match[2]);
  return match[1] === "display" ? { kind: "display", id } : { kind: "window", id };
}

/**
 * Os itens do menu, na ordem em que aparecem: a tela principal, as outras telas e as janelas (na ordem da
 * listagem, da frente para trás). Sem lista ainda, só a principal. Pura.
 */
export function targetOptions(listing: SnapshotListing | null): TargetOption[] {
  if (!listing) {
    return [{ value: "main", target: MAIN_TARGET, group: "display", disabled: false, blocked: null, display: null, window: null }];
  }
  const displays = [...listing.displays].sort((a, b) => Number(b.main) - Number(a.main));
  const options: TargetOption[] = displays.map((display): TargetOption => (display.main
    ? { value: "main", target: MAIN_TARGET, group: "display", disabled: false, blocked: null, display, window: null }
    : {
      value: `display:${display.id}`,
      target: { kind: "display", id: display.id },
      group: "display",
      disabled: !display.capturable,
      blocked: display.blocked,
      display,
      window: null,
    }));
  for (const window of listing.windows) {
    options.push({
      value: `window:${window.id}`,
      target: { kind: "window", id: window.id },
      group: "window",
      disabled: !window.capturable,
      blocked: window.capturable ? null : "permission",
      display: null,
      window,
    });
  }
  return options;
}

/** Texto de uma janela: o app e, quando a permissão deixa ver, o título. Pura. */
export function windowLabel(window: { app: string; title: string | null }): string {
  return window.title ? `${window.app} — ${window.title}` : window.app;
}

/**
 * Se a escolha ainda existe e pode ser capturada, fica; se a janela sumiu ou ficou bloqueada, volta para a tela
 * principal. Sem lista ainda, mantém a escolha. Pura.
 */
export function reconcileTarget(target: SnapshotTarget, listing: SnapshotListing | null): SnapshotTarget {
  if (target.kind === "main" || !listing) return target;
  const option = targetOptions(listing).find((candidate) => candidate.value === targetValue(target));
  return option && !option.disabled ? target : MAIN_TARGET;
}

/**
 * O índice do próximo item numa lista circular de `length` itens, a partir de `current` (-1 quando nenhum tem o foco).
 * É o que as setas do menu usam para passar pelos itens habilitados. Pura.
 */
export function stepIndex(current: number, length: number, delta: 1 | -1): number {
  if (length <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : length - 1;
  return (current + delta + length) % length;
}

/** Só a foto que o SnapShot gravou conta: o nome tem o prefixo do app e a extensão PNG. Pura. */
export function isSnapshotFile(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? "";
  return name.startsWith(SNAPSHOT_FILE_PREFIX) && name.endsWith(".png");
}

/** A legenda do anexo a partir do JSON ao lado. Sem JSON (ou sem app numa janela), não há legenda. Pura. */
export function snapshotCaption(info: SnapshotInfo | null): SnapshotCaption | null {
  if (!info) return null;
  if (info.scope === "window") {
    return info.app ? { kind: "window", app: info.app, title: info.title } : null;
  }
  if (info.displayNumber === null || info.displayNumber === 1) return { kind: "main" };
  return { kind: "display", number: info.displayNumber };
}
