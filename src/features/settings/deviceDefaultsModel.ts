import type { ResolvedTheme } from "@/features/settings/appearanceMode";

/**
 * Um ajuste do aparelho que volta ao padrão. `changed` diz se ele está fora do padrão; `restore`
 * devolve o padrão. O modelo não sabe de que ajuste se trata: quem sabe é o registro em
 * `deviceDefaults.ts`. Assim a regra de "só mexe no que mudou" e de "um erro não para os outros" fica
 * testada sem IPC, sem DOM e sem armazenamento.
 */
export interface DeviceDefault {
  readonly id: string;
  /** Chave i18n do nome que a confirmação lista ("Duração das animações"). */
  readonly labelKey: string;
  changed(): boolean | Promise<boolean>;
  restore(context: DeviceDefaultsContext): void | Promise<void>;
}

/** O que o restaurar precisa de fora do armazenamento: trocar o tema já aplicado na janela. */
export interface DeviceDefaultsContext {
  readonly setTheme: (theme: ResolvedTheme) => void;
}

/**
 * Os ajustes que estão fora do padrão, na ordem do registro. Um ajuste que não consegue ser lido
 * (armazenamento bloqueado) fica de fora: sem saber se mudou, não se mexe nele.
 */
export async function changedDeviceDefaults<T extends DeviceDefault>(defaults: readonly T[]): Promise<T[]> {
  const changed: T[] = [];
  for (const item of defaults) {
    try {
      if (await item.changed()) changed.push(item);
    } catch {
      // Ilegível: fica como está.
    }
  }
  return changed;
}

export interface DeviceDefaultsOutcome<T extends DeviceDefault> {
  readonly restored: readonly T[];
  /** Os que não voltaram ao padrão. Os outros continuam, um erro não cancela o resto. */
  readonly failed: readonly T[];
}

/** Devolve ao padrão cada ajuste da lista, na ordem. Um que falha não impede os seguintes. */
export async function restoreDeviceDefaults<T extends DeviceDefault>(
  items: readonly T[],
  context: DeviceDefaultsContext,
): Promise<DeviceDefaultsOutcome<T>> {
  const restored: T[] = [];
  const failed: T[] = [];
  for (const item of items) {
    try {
      await item.restore(context);
      restored.push(item);
    } catch {
      failed.push(item);
    }
  }
  return { restored, failed };
}

/** Compara dois valores pelo conteúdo: a ordem das chaves não importa, a dos itens de lista importa. */
export function sameSettingValue(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
    }
    return inner;
  });
}
