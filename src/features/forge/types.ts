/** Cuentas de hosting git y lo que se hace con ellas. Ver `src-tauri/src/forge`. */

export type ForgeKind = "github" | "gitlab" | "gitea" | "other";

export interface ForgeKindInfo {
  kind: ForgeKind;
  defaultHost: string | null;
  /** Si el host por defecto tiene inicio de sesión con navegador. */
  oauth: boolean;
  /** Si tiene API (PRs, issues, repos). Un host genérico solo tiene credenciales. */
  api: boolean;
}

export interface GitAccount {
  id: string;
  kind: ForgeKind;
  host: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  /** `oauth` (navegador) o `token` (pegado a mano). */
  auth: "oauth" | "token";
  gitUser: string | null;
  createdAt: number;
  /** `file` = no había llavero del sistema y el token quedó en un archivo 0600. */
  storage: "keyring" | "file" | null;
}

export interface DeviceStart {
  flowId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresIn: number;
  interval: number;
}

export type DevicePoll =
  | { status: "pending"; interval: number }
  | { status: "done"; account: GitAccount }
  | { status: "expired" }
  | { status: "denied" };

export interface ForgeRepo {
  fullName: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  archived: boolean;
  cloneUrl: string;
  sshUrl: string | null;
  webUrl: string;
  defaultBranch: string | null;
  updatedAt: string | null;
}

/** Qué repo es el del workspace y con qué cuenta se trabaja en él. */
export interface RepoTarget {
  root: string;
  remote: string;
  remoteUrl: string;
  host: string;
  path: string;
  kind: ForgeKind | null;
  account: GitAccount | null;
  accounts: GitAccount[];
  ssh: boolean;
}

export type ItemState = "open" | "closed" | "merged";

/** Un PR (merge request en GitLab) o un issue. */
export interface ForgeItem {
  number: number;
  title: string;
  state: ItemState;
  draft: boolean;
  author: string | null;
  webUrl: string;
  createdAt: string | null;
  updatedAt: string | null;
  comments: number | null;
  labels: string[];
  sourceBranch: string | null;
  targetBranch: string | null;
}

export interface ForgeComment {
  author: string | null;
  body: string;
  createdAt: string | null;
}

export interface ForgeItemDetail extends ForgeItem {
  body: string | null;
  thread: ForgeComment[];
}

export interface NewPull {
  title: string;
  body?: string;
  head: string;
  base: string;
  draft: boolean;
}

export interface NewIssue {
  title: string;
  body?: string;
  labels: string[];
}

export interface Label {
  name: string;
  /** Hex sin `#`. */
  color: string | null;
  description: string | null;
}

export interface Release {
  tag: string;
  name: string;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  webUrl: string;
  createdAt: string | null;
  author: string | null;
}

export interface NewRelease {
  tag: string;
  /** Dónde crear el tag si todavía no existe en el host: una rama o un commit. */
  target?: string;
  name?: string;
  body?: string;
  draft: boolean;
  prerelease: boolean;
}

/**
 * - `noAccount`: no hay cuenta para ese host (el mensaje ES el host).
 * - `auth`: el host rechazó el token; hay que volver a iniciar sesión.
 * - `unsupported`: cuenta genérica sin API, o repo sin remoto.
 */
export interface ForgeError {
  kind: "noAccount" | "auth" | "unsupported" | "api";
  message: string;
}

export function isForgeError(e: unknown): e is ForgeError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

export function forgeErrorOf(e: unknown): ForgeError {
  return isForgeError(e) ? e : { kind: "api", message: String(e) };
}

// ── guia de revisão de PR (ver `src-tauri/src/forge/guide.rs`) ─────────

/** Um arquivo que um PR toca, com o diff unificado quando o host o dá. */
export interface PullFile {
  path: string;
  oldPath: string | null;
  /** `added`, `removed`, `modified` o `renamed`. */
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface LineRange { start: number; end: number }

export interface GuideStopFile {
  path: string;
  /** Linhas na versão NOVA do arquivo. */
  lines?: LineRange;
}

/** Uma parada do roteiro: uma área do PR, por que importa e o que olhar de perto. */
export interface GuideStop {
  id: string;
  title: string;
  files: GuideStopFile[];
  why: string;
  lookClosely: string[];
  excerpt?: string;
  questions?: string[];
}

export type GuideRisk = "low" | "medium" | "high";

export interface ReviewGuide {
  summary: string;
  risk: GuideRisk;
  stops: GuideStop[];
}

/** O guia gravado em cache, por PR e pelo commit da cabeça. */
export interface GuideEntry {
  version: number;
  repo: string;
  number: number;
  headSha: string;
  /** Milissegundos. */
  createdAt: number;
  agentId: string;
  model: string | null;
  costUsd: number | null;
  attempts: number;
  guide: ReviewGuide;
}

export interface GuideLookup {
  entry: GuideEntry | null;
  /** O commit da cabeça agora; `null` = não se soube. */
  headSha: string | null;
  /** O guia é de outro commit: o PR andou depois. */
  stale: boolean;
}

export interface GuideOutcome {
  /** `null` = as duas tentativas falharam a validação; veja `raw` e `errors`. */
  entry: GuideEntry | null;
  raw: string | null;
  errors: string[];
  agentId: string;
  model: string | null;
}

export interface GuideRequest {
  /** `null` = automático. */
  agentId: string | null;
  accountId: string | null;
  autoAccount: boolean;
  model: string | null;
  lang: string;
  /** Onde o agente roda (o worktree do PR, se houver). */
  workdir: string | null;
}
