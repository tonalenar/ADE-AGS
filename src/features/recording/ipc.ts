import { invoke } from "@tauri-apps/api/core";

export type RecordingSource = "iphone" | "simulator" | "android" | "desktop";

export const screenRecordingStart = (kind: RecordingSource, target: string) =>
  invoke<string>("screen_recording_start", { kind, target });

export const screenRecordingStatus = () => invoke<string | null>("screen_recording_status");

export const screenRecordingStop = (id: string) => invoke<string>("screen_recording_stop", { id });

export const desktopScreenshot = () => invoke<string>("desktop_screenshot");

export const voiceInputStart = (locale: string, id: string) => invoke<string>("voice_input_start", { locale, id });

export const voiceInputStop = (id: string) => invoke<string>("voice_input_stop", { id });

export const voiceInputCancel = (id: string) => invoke<void>("voice_input_cancel", { id });
