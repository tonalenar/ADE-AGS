import { invoke } from "@tauri-apps/api/core";

export interface DesktopStatus {
  supported: boolean;
  installed: boolean;
  attached: boolean;
  ownerWindow: string | null;
  ownerView: string | null;
  automaticMessaging: boolean;
  orchestration: "assisted" | "automatic";
}
export interface Consult {
  id: string;
  cwd: string;
  prompt: string;
  status: "queued" | "working" | "completed" | "failed" | "cancelled";
  response: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  runTaskId?: string | null;
  role?: string | null;
}
export interface PanelBounds {
  x: number; y: number; width: number; height: number; scale: number; visible: boolean;
}
export const desktopStatus = () => invoke<DesktopStatus>("gemini_desktop_status");
let mutations: Promise<unknown> = Promise.resolve();
function mutate<T>(request: () => Promise<T>): Promise<T> {
  const result = mutations.then(request, request);
  mutations = result.then(() => undefined, () => undefined);
  return result;
}
export const desktopAttach = (viewId: string) => mutate(() => invoke<DesktopStatus>("gemini_desktop_attach", { viewId }));
export const desktopLayout = (viewId: string, bounds: PanelBounds) => mutate(() => invoke<void>("gemini_desktop_layout", { viewId, bounds }));
export const desktopDetach = (viewId: string) => mutate(() => invoke<void>("gemini_desktop_detach", { viewId }));
export const desktopTasks = (cwd: string) => invoke<Consult[]>("gemini_desktop_tasks", { cwd });
export const executeConsult = (viewId: string, cwd: string, id: string) =>
  invoke<Consult>("gemini_desktop_execute", { viewId, cwd, id });
export const applyDesktopPlan = (cwd: string, id: string, plan: string) => invoke("gemini_desktop_apply_plan", { cwd, id, plan });
export const updateConsult = (cwd: string, id: string, status: Consult["status"], response?: string, error?: string) =>
  invoke<void>("gemini_desktop_task_update", { cwd, id, status, response: response ?? null, error: error ?? null });
export const retryConsult = (cwd: string, id: string) =>
  invoke<void>("gemini_desktop_task_retry", { cwd, id });
