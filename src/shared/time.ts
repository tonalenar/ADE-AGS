export type RelativeCompactUnit = "s" | "m" | "h" | "d" | "mo" | "y";

const COMPACT_UNITS: readonly [number, RelativeCompactUnit, Intl.NumberFormatOptions["unit"]][] = [
  [60, "s", "second"],
  [60, "m", "minute"],
  [24, "h", "hour"],
  [30, "d", "day"],
  [12, "mo", "month"],
  [Infinity, "y", "year"],
];

/** Quebra a diferença entre `nowSec` e `unixSeconds` na maior unidade inteira (`s`, `m`, `h`, `d`, `mo`, `y`). */
export function relativeAgeParts(
  unixSeconds: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): { value: number; unit: RelativeCompactUnit; intlUnit: Intl.NumberFormatOptions["unit"] } {
  let value = Math.max(0, nowSec - unixSeconds);
  let unit: RelativeCompactUnit = "s";
  let intlUnit: Intl.NumberFormatOptions["unit"] = "second";
  for (const [size, shortLabel, intlLabel] of COMPACT_UNITS) {
    if (value < size) {
      unit = shortLabel;
      intlUnit = intlLabel;
      break;
    }
    value = Math.floor(value / size);
    unit = shortLabel;
    intlUnit = intlLabel;
  }
  return { value, unit, intlUnit };
}

/** `"5m"`, `"2h"`, `"3d"` com a unidade abreviada pelo idioma (`Intl.NumberFormat`). */
export function formatRelativeUnit(
  unixSeconds: number,
  language = "pt-BR",
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  const { value, intlUnit } = relativeAgeParts(unixSeconds, nowSec);
  try {
    return new Intl.NumberFormat(language, { style: "unit", unit: intlUnit, unitDisplay: "narrow" }).format(value);
  } catch {
    return `${value} ${intlUnit}`;
  }
}

/** `"42s"`, `"5m"`, `"2h"`, `"3d"` sem i18n (retorna `""` se `unixSeconds == null`). */
export function formatShortAgo(
  unixSeconds: number | null,
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  if (unixSeconds == null) return "";
  const diffS = Math.max(0, nowSec - unixSeconds);
  if (diffS < 60) return `${diffS}s`;
  if (diffS < 3600) return `${Math.floor(diffS / 60)}m`;
  if (diffS < 86400) return `${Math.floor(diffS / 3600)}h`;
  return `${Math.floor(diffS / 86400)}d`;
}
