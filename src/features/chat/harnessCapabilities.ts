import { useEffect } from "react";
import { create } from "zustand";

import { harnessCapabilityMatrix, type HarnessCapabilityMatrixRow } from "./ipc";

export type HarnessSurface = "chat" | "fleet" | "tui";
export type HarnessSupport = "supported" | "unsupported" | "unknown";

// Exceções de compatibilidade: a matriz diverge da oferta atual de comandos em algumas superfícies.
// Não sobrescrever essas divergências nesta fase.
const LEGACY_COMPOSER_CAPABILITIES = new Set([
  "tui:claude-code:autocompact",
  "chat:claude-code:autocompact",
]);
const LEGACY_GOAL_CLEAR_ALIAS_PROVIDERS = new Set(["claude-code"]);
const GOAL_PAUSE_RESUME_PROVIDERS = new Set(["codex"]);
const LEGACY_GOAL_CLEAR_ALIASES = /^(stop|off|reset|none|cancel)$/i;

interface HarnessCapabilityState {
  matrix: HarnessCapabilityMatrixRow[] | null;
  loading: boolean;
  load: () => Promise<void>;
}

let matrixRequest: Promise<void> | null = null;

const useHarnessCapabilityStore = create<HarnessCapabilityState>((set) => ({
  matrix: null,
  loading: true,
  load: () => {
    if (matrixRequest) return matrixRequest;
    set({ loading: true });
    matrixRequest = harnessCapabilityMatrix()
      .then((matrix) => { set({ matrix }); })
      .catch(() => { set({ matrix: null }); })
      .finally(() => { set({ loading: false }); matrixRequest = null; });
    return matrixRequest;
  },
}));

export interface CapabilityAvailability {
  support: HarnessSupport;
  available: boolean;
  reason: string | null;
  loading: boolean;
}

/** `Unknown` (inclusive ausência de linha ou falha do IPC) conserva o caminho existente. */
export function capabilityAvailability(support: HarnessSupport, note: string, loading = false): CapabilityAvailability {
  return {
    support,
    available: support !== "unsupported",
    reason: support === "unsupported" ? note : null,
    loading,
  };
}

export function matrixProviderForAgent(agentId: string | null | undefined): string | null {
  if (!agentId) return null;
  return agentId.startsWith("local-acp-") ? "local-acp" : agentId;
}

/** Mantém exceções legadas documentadas junto ao acesso à matriz, não nos componentes. */
export function legacyComposerCapabilityAvailable(surface: HarnessSurface, provider: string | null, capability: string): boolean {
  return provider !== null && LEGACY_COMPOSER_CAPABILITIES.has(`${surface}:${provider}:${capability}`);
}

/** Resolve os aliases legados do comando sem embutir a comparação ao provider no componente. */
export function isLegacyGoalClearAlias(provider: string | null, argument: string): boolean {
  return provider !== null && LEGACY_GOAL_CLEAR_ALIAS_PROVIDERS.has(provider) && LEGACY_GOAL_CLEAR_ALIASES.test(argument);
}

/** Não há célula própria para pause/resume; conserva o recorte de `EngineCapabilities`. */
export function goalPauseResumeAvailable(provider: string | null): boolean {
  return provider !== null && GOAL_PAUSE_RESUME_PROVIDERS.has(provider);
}

/** Lê a matriz do backend uma vez e deixa qualquer tela consultar as mesmas células. */
export function useHarnessCapability(surface: HarnessSurface, provider: string | null | undefined, capability: string): CapabilityAvailability {
  const matrix = useHarnessCapabilityStore((state) => state.matrix);
  const loading = useHarnessCapabilityStore((state) => state.loading);
  const load = useHarnessCapabilityStore((state) => state.load);
  useEffect(() => { void load(); }, [load]);

  const row = provider ? matrix?.find((entry) => entry.surface === surface && entry.provider === provider) : undefined;
  const claim = row?.cells.find((cell) => cell.capability === capability)?.claim;
  return capabilityAvailability(claim?.support ?? "unknown", claim?.note ?? "", loading && !matrix);
}

/** Permite consultar estado carregado em lógica sem componente, mantendo o store único. */
export function readHarnessCapability(surface: HarnessSurface, provider: string, capability: string): CapabilityAvailability {
  const state = useHarnessCapabilityStore.getState();
  const matrix = state.matrix;
  const claim = matrix?.find((entry) => entry.surface === surface && entry.provider === provider)
    ?.cells.find((cell) => cell.capability === capability)?.claim;
  return capabilityAvailability(claim?.support ?? "unknown", claim?.note ?? "", state.loading && !matrix);
}
