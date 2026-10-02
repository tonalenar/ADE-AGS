/**
 * Comandos de cuentas. Ver `accounts/commands.rs`.
 *
 * Como el resto de los `ipc.ts`, es el ÚNICO archivo de esta feature que habla con Tauri:
 * el nombre del comando y la forma de sus argumentos viven acá y en ningún otro lado. Un
 * `invoke("...")` suelto en un componente es un contrato con el backend escrito en un
 * string que nada verifica — y renombrar el comando en Rust no rompe nada hasta que el
 * usuario aprieta el botón.
 */
import { invoke } from "@tauri-apps/api/core";

import type { AccountCapableAgent, AccountHealth, AgentAccount } from "./types";

export const listAccounts = () => invoke<AgentAccount[]>("list_agent_accounts");
export const listSystemAccounts = () => invoke<AgentAccount[]>("system_accounts");

export const listCapableAgents = () => invoke<AccountCapableAgent[]>("account_capable_agents");

export const createAccount = (agentId: string, name: string) =>
  invoke<AgentAccount>("create_agent_account", { agentId, name });

/** Cuenta por API key: Claude Code (llavero) o Codex (`codex login --with-api-key`). */
export const createApiKeyAccount = (agentId: string, name: string, apiKey: string, baseUrl: string | null) =>
  invoke<AgentAccount>("create_agent_api_key_account", { agentId, name, apiKey, baseUrl });

/** Le pregunta a la CLI (o al proveedor) si la cuenta funciona. No gasta tokens. */
export const accountHealth = (accountId: string) => invoke<AccountHealth>("account_health", { accountId });

export const deleteAccount = (id: string, deleteFiles: boolean) =>
  invoke<void>("delete_agent_account", { id, deleteFiles });

/** Variables con las que hay que lanzar un proceso para que corra con esta cuenta. */
export const accountEnv = (accountId: string) =>
  invoke<Record<string, string>>("agent_account_env", { accountId });

export type AntigravityOAuthAccount = { id: string; name: string; email: string; connected: boolean };
export type AntigravityOAuthConfig = { clientId: string | null; configured: boolean };
export type AntigravityOAuthProgress =
  | { status: "pending" }
  | { status: "connected"; account: AntigravityOAuthAccount }
  | { status: "failed"; message: string };
export const antigravityOAuthConfig = () => invoke<AntigravityOAuthConfig>("antigravity_oauth_config");
export const configureAntigravityOAuth = (clientId: string, clientSecret: string) =>
  invoke<void>("antigravity_oauth_configure", { clientId, clientSecret });
export const antigravityOAuthAccounts = () => invoke<AntigravityOAuthAccount[]>("antigravity_oauth_accounts");
export const startAntigravityOAuth = (name: string) =>
  invoke<{ flowId: string; authorizationUrl: string }>("antigravity_oauth_start", { name });
export const pollAntigravityOAuth = (flowId: string) =>
  invoke<AntigravityOAuthProgress>("antigravity_oauth_poll", { flowId });
export const cancelAntigravityOAuth = (flowId: string) => invoke<void>("antigravity_oauth_cancel", { flowId });
export const verifyAntigravityOAuth = (accountId: string) => invoke<void>("antigravity_oauth_verify", { accountId });
export type AntigravityAccountDiscovery = {
  accountId: string;
  projectId: string;
  models: Array<{ id: string; name: string }>;
  inferenceVerified: boolean;
};
export const discoverAntigravityAccount = (accountId: string) =>
  invoke<AntigravityAccountDiscovery>("antigravity_account_discovery", { accountId });
