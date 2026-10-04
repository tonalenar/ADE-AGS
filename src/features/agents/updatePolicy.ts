/** Lógica pura de las actualizaciones de agentes; la política de seguridad real vive en el backend. */

export type AgentUpdateReason =
  | "not_npm"
  | "no_updater"
  | "check_failed"
  | "busy_terminal"
  | "busy_mission";

export interface AgentUpdateInfo {
  agentId: string;
  label: string;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  canAutoUpdate: boolean;
  busy: boolean;
  reason: AgentUpdateReason | string | null;
}

export interface AgentUpdateResult {
  agentId: string;
  ok: boolean;
  output: string;
  newVersion: string | null;
  error: string | null;
}

export const AUTO_UPDATE_SETTING_KEY = "agents.autoUpdate";
export const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Opt-in: solo el texto exacto "true" lo prende. */
export function isAutoUpdateEnabled(raw: string | null | undefined): boolean {
  return raw === "true";
}

/** El aviso (y el botón) solo aplican cuando hay una versión nueva conocida. */
export function hasUpdate(info: AgentUpdateInfo): boolean {
  return info.updateAvailable && !!info.latestVersion;
}

export function notifyKey(info: AgentUpdateInfo): string {
  return `${info.agentId}@${info.latestVersion ?? ""}`;
}

/** Qué agentes merecen un aviso: con novedad y que no se avisaron ya para esa versión. */
export function selectToastTargets(infos: AgentUpdateInfo[], notified: ReadonlySet<string>): AgentUpdateInfo[] {
  return infos.filter((i) => hasUpdate(i) && !notified.has(notifyKey(i)));
}

/** Modo automático: solo los que pueden actualizarse solos y están ociosos. */
export function selectAutoUpdateTargets(infos: AgentUpdateInfo[]): AgentUpdateInfo[] {
  return infos.filter((i) => hasUpdate(i) && i.canAutoUpdate && !i.busy);
}

export interface UpdateButtonState {
  visible: boolean;
  enabled: boolean;
  /** Código estable de por qué está deshabilitado. */
  disabledReason: string | null;
}

export function updateButtonState(info: AgentUpdateInfo, running: boolean): UpdateButtonState {
  if (!hasUpdate(info)) return { visible: false, enabled: false, disabledReason: null };
  if (running) return { visible: true, enabled: false, disabledReason: "running" };
  if (info.busy || !info.canAutoUpdate) {
    return { visible: true, enabled: false, disabledReason: info.reason ?? "no_updater" };
  }
  return { visible: true, enabled: true, disabledReason: null };
}
