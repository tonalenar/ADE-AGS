/** Tipos do gerador de licenças (`gen-licenses.mjs`), para os testes em TypeScript importarem as funções puras. */
export interface LicenseRecord {
  ecosystem: "npm" | "crates";
  name: string;
  version: string;
  license: string | null;
  lida?: boolean;
  licencaDe?: string;
}

export function splitNameVersion(spec: string): { name: string; version: string };
export function nodeModulesPath(key: string): string;
export function npmLicense(pkg: Record<string, unknown>): string | null;
export function parseBunLock(text: string): { packages?: Record<string, unknown> };
export function platformFamily(name: string): string;
export function collectNpm(
  lockText: string,
  readPackageJson: (path: string, name: string, version: string) => Record<string, unknown> | null,
): { items: LicenseRecord[]; missing: string[] };
export function collectCrates(metadata: { packages?: Record<string, unknown>[] }): LicenseRecord[];
export function sortItems(items: LicenseRecord[]): LicenseRecord[];
