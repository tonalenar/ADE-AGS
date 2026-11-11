import { invoke } from "@tauri-apps/api/core";

import { MAIN_TARGET, type SnapshotInfo, type SnapshotListing, type SnapshotTarget } from "./snapshotTargets";

export type RecordingSource = "iphone" | "simulator" | "android" | "desktop";

export const screenRecordingStart = (kind: RecordingSource, target: string) =>
  invoke<string>("screen_recording_start", { kind, target });

export const screenRecordingStatus = () => invoke<string | null>("screen_recording_status");

export const screenRecordingStop = (id: string) => invoke<string>("screen_recording_stop", { id });

/** `desktop_screenshot` em `computer_use/snapshot.rs`: sem escolha, a tela principal, como antes. */
export const desktopScreenshot = (target: SnapshotTarget = MAIN_TARGET) => invoke<string>("desktop_screenshot", { target });

/** `snapshot_targets` em `computer_use/snapshot.rs`: telas e janelas que o seletor mostra. Não captura nada. */
export const desktopSnapshotTargets = () => invoke<SnapshotListing>("snapshot_targets");

/** `snapshot_info` em `computer_use/snapshot.rs`: a legenda de cada PNG (o JSON ao lado), ou `null`. */
export const desktopSnapshotInfo = (paths: string[]) => invoke<(SnapshotInfo | null)[]>("snapshot_info", { paths });

export const voiceInputStart = (locale: string, id: string) => invoke<string>("voice_input_start", { locale, id });

export const voiceInputStop = (id: string) => invoke<string>("voice_input_stop", { id });

export const voiceInputCancel = (id: string) => invoke<void>("voice_input_cancel", { id });

/** Abre um dos painéis de privacidade de macOS permitidos pelo backend. */
export type PrivacySettingsPane = "screen_capture" | "microphone" | "speech_recognition";
export const openPrivacySettings = (pane: PrivacySettingsPane) => invoke<void>("open_privacy_settings", { pane });
