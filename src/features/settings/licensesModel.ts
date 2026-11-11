import { normalizeSettingsSearch } from "@/features/settings/settingsNav";

/**
 * A lista de licenças das dependências, sem React. O JSON é gerado por `bun run licenses:gen`
 * (`scripts/gen-licenses.mjs`): npm pelo `bun.lock`, crates pelo `Cargo.lock`.
 */

export interface LicenseItem {
  readonly ecosystem: "npm" | "crates";
  readonly name: string;
  readonly version: string;
  /** Como o pacote declara a licença; `null` quando não declara ou quando não foi lido nesta máquina. */
  readonly license: string | null;
  /** `false` quando o pacote não foi lido nesta máquina (sai sem licença, sem chute). */
  readonly lida?: boolean;
  /** O pacote-irmão de plataforma de onde veio a licença (mesma família e versão). */
  readonly licencaDe?: string;
}

export interface LicensesData {
  readonly contagem: {
    readonly total: number;
    readonly npm: number;
    readonly crates: number;
    readonly naoLidas: number;
    readonly semLicenca: number;
  };
  readonly itens: readonly LicenseItem[];
}

/**
 * Os itens que a busca acha: o nome, a versão, o ecossistema ou a licença têm de conter cada palavra
 * (sem caixa nem acento, em qualquer ordem). Busca vazia devolve tudo, na ordem do arquivo.
 */
export function filterLicenses(items: readonly LicenseItem[], query: string): LicenseItem[] {
  const q = normalizeSettingsSearch(query);
  if (!q) return [...items];
  const tokens = q.split(" ");
  return items.filter((item) => {
    const fields = [
      normalizeSettingsSearch(item.name),
      normalizeSettingsSearch(item.version),
      item.ecosystem,
      normalizeSettingsSearch(item.license ?? ""),
    ];
    return tokens.every((token) => fields.some((field) => field.includes(token)));
  });
}

/** Quantas dependências têm cada licença, da mais comum para a menos. `null` agrupa os sem licença. */
export function licenseGroups(items: readonly LicenseItem[]): { license: string | null; count: number }[] {
  const counts = new Map<string | null, number>();
  for (const item of items) {
    const key = item.lida === false ? null : (item.license ?? null);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // "Sem licença" não é uma licença: fica por último, mesmo quando empata com a mais comum.
  const named = [...counts.entries()]
    .filter(([license]) => license !== null)
    .map(([license, count]) => ({ license, count }))
    .sort((a, b) => b.count - a.count || (a.license ?? "").localeCompare(b.license ?? "", "en"));
  const none = counts.get(null);
  return none === undefined ? named : [...named, { license: null, count: none }];
}
