/** Instalación de la CLI `ags` en el PATH del usuario. Ver `ipc/install.rs`. */
import { invoke } from "@tauri-apps/api/core";

export interface CliInstallStatus {
  installed: boolean;
  targetPath: string;
  sourcePath: string | null;
  dirInPath: boolean;
  targetDir: string;
  method: "symlink" | "copy";
}

export const cliInstallStatus = () => invoke<CliInstallStatus>("cli_install_status");

export const installCli = () => invoke<CliInstallStatus>("install_cli");

export const uninstallCli = () => invoke<CliInstallStatus>("uninstall_cli");

/** Armazenamento: `storage_overview` e `storage_clean_old` (`src-tauri/src/storage_usage.rs`). */
export type StorageAreaId = "database" | "chatWorktrees" | "runWorktrees" | "deviceCaptures" | "browserCaptures";

export interface StorageArea {
  id: StorageAreaId;
  bytes: number;
  files: number;
  /** O que a limpeza removeria (arquivos com mais de sete dias). Zero fora das áreas de captura. */
  oldBytes: number;
  oldFiles: number;
  cleanable: boolean;
}

export interface StorageCleanResult {
  files: number;
  bytes: number;
}

export const storageOverview = () => invoke<StorageArea[]>("storage_overview");

export const storageCleanOld = (area: StorageAreaId) => invoke<StorageCleanResult>("storage_clean_old", { area });

/** Diagnóstico, só leitura: `diagnostics_snapshot` (`src-tauri/src/diagnostics.rs`). */
export interface DiagnosticsTerminal {
  id: number;
  tabId: string | null;
  outputBytes: number;
}

export interface DiagnosticsSnapshot {
  version: string;
  dataDir: string | null;
  isolated: boolean;
  databaseBytes: number;
  terminals: DiagnosticsTerminal[];
}

export const diagnosticsSnapshot = () => invoke<DiagnosticsSnapshot>("diagnostics_snapshot");

/** Uso e preços: `usage_prices_get`, `usage_price_set` e `usage_price_clear` (`src-tauri/src/usage/pricing.rs`). */
export interface PriceOverride {
  model: string;
  input: number;
  output: number;
}

export interface ListPrice {
  family: string;
  input: number;
  output: number;
}

export interface PricesView {
  overrides: PriceOverride[];
  list: ListPrice[];
}

export const usagePricesGet = () => invoke<PricesView>("usage_prices_get");

export const usagePriceSet = (model: string, input: number, output: number) =>
  invoke<PricesView>("usage_price_set", { model, input, output });

export const usagePriceClear = (model: string) => invoke<PricesView>("usage_price_clear", { model });
