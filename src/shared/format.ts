export interface FormatBytesOptions {
  /** Texto quando o valor é `<= 0` ou não finito (ex.: `"0 B"` ou `"—"`). */
  readonly invalidText?: string;
  /** Lista de unidades (padrão: `["B", "KB", "MB", "GB", "TB"]`). */
  readonly units?: readonly string[];
  /** Quando `true`, mantém sempre 1 casa decimal a partir da 2ª unidade; senão usa 1 casa só abaixo de 10. */
  readonly alwaysOneDecimal?: boolean;
  /** Quando `true`, arredonda valores de bytes (`unit === 0`) e trata `<= 0` como `"0 B"`. */
  readonly zeroAsZeroBytes?: boolean;
}

const DEFAULT_BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Formata um tamanho em bytes sem depender de locale. */
export function formatBytes(bytes: number, options: FormatBytesOptions = {}): string {
  const units = options.units ?? DEFAULT_BYTE_UNITS;
  if (options.zeroAsZeroBytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return options.invalidText ?? "0 B";
  } else if (!Number.isFinite(bytes) || bytes < 0) {
    return options.invalidText ?? "—";
  }

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${options.zeroAsZeroBytes ? Math.round(value) : value} ${units[0]}`;
  if (options.alwaysOneDecimal) {
    return `${value.toFixed(1)} ${units[unit]}`;
  }
  let shown = value < 10 ? Number(value.toFixed(1)) : Math.round(value);
  if (shown >= 1024 && unit < units.length - 1) {
    unit += 1;
    shown = shown / 1024;
    shown = shown < 10 ? Number(shown.toFixed(1)) : Math.round(shown);
  }
  return `${shown < 10 ? shown.toFixed(1) : shown} ${units[unit]}`;
}

/** Formata bytes no estilo `"3.0 KiB"` / `"812 B"`. */
export function formatKibBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

/** Formata contagem de tokens em ordem de grandeza: `"840"`, `"1.2k"`, `"124k"`, `"1.2M"`. */
export function formatCompactTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Formata contagem de tokens em notação compacta segundo o idioma da UI. */
export function formatLocaleTokens(n: number, lang: string): string {
  try {
    return new Intl.NumberFormat(lang, { notation: "compact", maximumFractionDigits: 1 }).format(n);
  } catch {
    return String(n);
  }
}
