/** Metadados de um login guardado no cofre do sistema (nunca contém a senha). */
export interface VaultEntry {
  id: string;
  origin: string;
  username: string;
  label: string;
  created_at: number;
  last_used_at: number | null;
  allowed_agents: string[];
}

export type VaultConfirmDecision = "once" | "always" | "decline";

export type VaultRegisterResult =
  | { id: string }
  | { declined: true }
  | { status: "pending" };

export interface VaultRegisterPrompt {
  mode: "register";
  id: string;
  origin: string;
  reason: string;
  from: string;
  fromId: string;
  expiresAt: number;
  resolve: (result: VaultRegisterResult) => void;
}

export interface VaultConfirmPrompt {
  mode: "confirm";
  id: string;
  entry: VaultEntry;
  pageOrigin: string;
  from: string;
  fromId: string;
  expiresAt: number;
  resolve: (decision: VaultConfirmDecision) => void;
}

export type VaultPrompt = VaultRegisterPrompt | VaultConfirmPrompt;
