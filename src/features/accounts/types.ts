/** Ver `accounts::AgentAccount` en Rust. */
export interface AgentAccount {
  id: string;
  agentId: string;
  /** Nombre simbólico elegido por el usuario; también es el nombre de la carpeta. */
  name: string;
  dir: string;
  /** Variable de entorno que apunta la TUI a esta cuenta (ej. `CLAUDE_CONFIG_DIR`). */
  envVar: string;
  /** Comando que abre el login de esa TUI. */
  loginCommand: string;
  /** Si la TUI dejó rastro de una sesión iniciada dentro de este perfil. */
  loggedIn: boolean;
  /** Mail (u otro identificador) de la cuenta, cuando la TUI lo expone. */
  label: string | null;
  createdAt: number;
  /** `login`: el login hecho en la TUI. `api_key`: una key (ver `accounts::secrets`). */
  kind: "login" | "api_key";
  /** Endpoint compatible en vez del oficial (solo cuentas `api_key` de Claude Code). */
  baseUrl: string | null;
  /** Los últimos caracteres de la key, para reconocerla. Nunca la key. */
  keyHint: string | null;
}

/** Ver `accounts::health::AccountHealth`. */
export interface AccountHealth {
  status: "ok" | "not_logged_in" | "invalid" | "unknown";
  /** Lo que dijo la CLI o el proveedor (`claude.ai`, `HTTP 401`). */
  detail: string;
  email: string | null;
  plan: string | null;
  checkedAt: number;
}

/** TUI que soporta cuentas múltiples. Ver `accounts::AccountCapableAgent`. */
export interface AccountCapableAgent {
  agentId: string;
  label: string;
  envVar: string;
  installed: boolean;
}

/** Ver `runs::quota::QuotaWindow`: utilización de 0 a 1 (puede pasarse con excedente). */
export interface QuotaWindow {
  utilization: number;
  resetsAt: number | null;
}

/** Ver `accounts::health::CodexUsage`. */
export interface CodexUsage {
  email: string | null;
  plan: string | null;
  /** `chatgpt` o `apiKey`: con API key no hay ventanas de límite. */
  auth: string | null;
  quota: {
    fiveHour: QuotaWindow | null;
    sevenDay: QuotaWindow | null;
    rejected: boolean;
    rejectedUntil: number | null;
    overage: boolean;
  } | null;
  fetchedAt: number;
}
