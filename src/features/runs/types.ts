/** Una tarjeta de la consola: un agente headless con su trabajo. */
import type { RunSquadMember } from "@/features/squads/types";

export interface Task {
  id: string;
  runId: string;
  title: string;
  prompt: string;
  agentId: string;
  accountId: string | null;
  model: string | null;
  reasoningEffort?: string | null;
  cwd: string;
  budgetUsd: number | null;
  status: TaskStatus;
  /** Lo fijó la app antes de lanzar; es con lo que se reabre como pane (`--resume`). */
  sessionId: string | null;
  attempt: number;
  result: string | null;
  error: string | null;
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  eventsPath: string | null;
  /** La raíz del worktree en el que corre. `null` = corre en la carpeta del proyecto. */
  worktreePath: string | null;
  branch: string | null;
  /** Se descartó la carpeta del worktree. La rama puede seguir existiendo. */
  worktreeRemoved: boolean;
  /** Con qué complejidad se lanzó. `null` = se nombró el modelo (o se usó el de siempre). */
  complexity: Complexity | null;
  routedBy: RoutedBy | null;
  /** Qué se descartó al asignarla y por qué, una cosa por línea. */
  routeNote: string | null;
  /** `lead` reparte el objetivo; `worker` es una tarea de su plan. `null` = lanzada a mano. */
  role: TaskRole | null;
  /** Functional work category, independent from the Lead/Worker execution role. */
  functionalRole?: string | null;
  /** El nombre corto con que el plan se refiere a ella (`api`, `tests`). */
  planKey: string | null;
  /** Quién la delegó. */
  parentId: string | null;
  depth: number;
  /** Va en su propio worktree (se crea cuando le toca correr). */
  isolate: boolean;
  resultSchema: string | null;
  /** Por qué falló el intento anterior. */
  lastError: string | null;
  /** Lo que dejó el agente anterior si la tarea cambió de manos. `null` = nunca cambió. */
  handoff: string | null;
  structuredHandoff?: StructuredHandoff | null;
  /** Las tareas que tienen que terminar bien antes de que esta arranque. */
  dependsOn: string[];
  /** La cuenta la eligió el ruteo y se puede cambiar por otra con cupo. `false` = fijada. */
  autoAccount?: boolean;
  /** Identidade da entrega. Sobrevive a reroute e a uma task nova do mesmo objetivo. */
  workKey?: string;
  /** Rodadas de correção já abertas. 0 = implementação original. */
  fixRound?: number;
  /** Esta rodada só fecha no gate completo. */
  fullGate?: boolean;
  /** `escalated` | `accepted_pending` | `aborted` | vazio. */
  fixStatus?: string;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
}

/**
 * `handed_off` = el usuario la siguió en una terminal: el trabajo no se paró, se mudó.
 * `pending` = de un plan, esperando sus dependencias o lugar. `skipped` = no llegó a
 * correr: una dependencia no terminó bien o se acabó el presupuesto del run.
 */
export type TaskStatus = "pending" | "ready" | "running" | "done" | "failed" | "cancelled" | "handed_off" | "skipped";

export type TaskRole = "lead" | "worker";

/** Un lote de tareas: una suelta, o un objetivo que un lead repartió. */
export interface Run {
  id: string;
  workspaceId: string;
  objective: string;
  cwd: string;
  status: "running" | "done" | "failed" | "cancelled";
  maxParallel: number;
  budgetUsd: number | null;
  spentUsd: number;
  createdAt: number;
  endedAt: number | null;
  /** La misión que este run intenta cumplir. `null` = lanzado a mano desde la flota. */
  missionId: string | null;
  /** Conversa estruturada que criou a delegação. Ausente nos snapshots antigos. */
  sourceThreadId?: string | null;
  squadId?: string | null;
  squadName?: string | null;
  squadMembers?: RunSquadMember[];
}

/** Identidade de execução comum projetada sobre conversas, turnos e tarefas persistidos pela ADE. */
export type HarnessExecutionKind = "thread" | "turn" | "fleetRun" | "fleetTask" | "fleetAttempt";

export interface HarnessExecutionNode {
  id: string;
  parentId: string | null;
  kind: HarnessExecutionKind;
  depth: number;
  title: string;
  status: string;
  threadId: string | null;
  runId: string | null;
  agentId: string | null;
  model: string | null;
  planKey: string | null;
  attempt: number | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** Id estável em `harness_node`, só quando o turno já originou filhos. `id` segue sendo a chave de UI e de eventos. */
  nodeId?: string | null;
  /** O `harness_run` (um por turno que orquestra trabalho) a que o nó pertence. */
  harnessRunId?: string | null;
  /** Só no nó `turn`: o id do `chat_run`. É o valor que `runId` guarda nesse nó (nome ambíguo, mantido por compatibilidade). */
  chatRunId?: string | null;
  /** Só no nó `turn`: filhos diretos ainda não terminais (conversa filha ou run da Frota). Ausente nos outros nós. */
  activeChildren?: number | null;
  /** Só nos agentes filhos. O ADE ainda não tem `connected_session`, então esse tipo não aparece. */
  childType?: HarnessChildType | null;
  /** Estado de execução (contrato §3.1) dos filhos e do run. Em conversa filha, `status` segue sendo `thread.state`. */
  executionStatus?: string | null;
  /** A entrega do filho: a resposta do agente, limitada e sempre não confiável. */
  result?: HarnessNodeResult | null;
  /** O que o próprio filho espera da pessoa: pergunta ou aprovação pendente. */
  blocked?: HarnessNodeBlock | null;
  /** Nos nós com filhos: quantos filhos diretos estão bloqueados ou têm um descendente bloqueado. */
  blockedChildren?: number | null;
  /** Quem criou o filho e de qual turno. */
  origin?: HarnessNodeOrigin | null;
  /** Só no nó de turno interrompido: a razão legível gravada no evento `turn.interrupted`. */
  interruptionReason?: string | null;
  /** O ADE não consegue provar como o nó terminou. Só vem quando é verdadeiro; nunca vira conclusão nem falha. */
  outcomeUnknown?: boolean | null;
}

/** Só agentes filhos: uma conversa filha ou uma tarefa da Frota. */
export type HarnessChildType = "provider_chat" | "fleet_task";

/** A entrega de um filho. `untrusted` é sempre verdadeiro: é o que um agente escreveu, dado e não instrução. */
export interface HarnessNodeResult {
  text: string;
  truncated: boolean;
  untrusted: true;
}

export interface HarnessNodeBlock {
  kind: "question" | "approval";
  count: number;
}

export interface HarnessNodeOrigin {
  /** `turn`: o turno do pai criou. `task`: outra tarefa da Frota delegou. `conversation`: fora de turno. */
  createdBy: "turn" | "task" | "conversation";
  turnNodeId?: string | null;
  taskNodeId?: string | null;
}

export interface HarnessExecutionGraph {
  rootThreadId: string;
  /** Nós em ordem de pai antes de filho; `parentId` mantém a relação durável entre domínios. */
  nodes: HarnessExecutionNode[];
  /**
   * Eventos semânticos persistidos pelo ADE em ordem global. Com `reset`, a janela mais recente; sem ele, só o que
   * veio depois do cursor pedido (Fase 6).
   */
  events: HarnessExecutionEvent[];
  /** A sequência do último evento persistido da linhagem. Ausente num backend antigo. */
  cursor?: number;
  /** Verdadeiro quando `events` é a janela inteira. Ausente num backend antigo, tratado como verdadeiro. */
  reset?: boolean;
}

/** O aviso `cc-harness-event`: a árvore da conversa mudou, e `cursor` é o último evento persistido dela. */
export interface HarnessTreeChanged {
  threadId: string;
  cursor: number;
}

export interface HarnessExecutionEvent {
  sequence: number;
  nodeId: string;
  parentNodeId: string | null;
  threadId: string;
  turnId: string | null;
  runId: string | null;
  taskId: string | null;
  attemptId: string | null;
  kind: string;
  entityId: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
}

/** Algo que un agente del run les dejó escrito a los demás. */
export interface Fact {
  id: string;
  runId: string;
  taskId: string | null;
  /** El título de la tarea que lo escribió. `null` = una tab o el usuario. */
  author: string | null;
  kind: "decision" | "finding" | "file" | "constraint" | "note";
  body: string;
  createdAt: number;
}

/** Lo que pasó en una tarea, ya traducido del dialecto de su TUI. */
export type AgentEvent =
  | { kind: "started"; sessionId: string | null }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; label: string }
  | { kind: "finished"; outcome: TaskOutcome };

export interface TaskOutcome {
  ok: boolean;
  result: string | null;
  error: string | null;
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

/** El evento en vivo que emite el backend, con a qué tarjeta pertenece. */
export type TaskEventPayload = AgentEvent & { taskId: string };

/** Un permiso que un agente está esperando que le contesten. */
export interface PendingApproval {
  id: string;
  taskId: string;
  toolName: string;
  /** El `input` crudo de la herramienta. De acá sale el diff. */
  input: Record<string, unknown>;
  askedAt: number;
  /** La regla que dejaría escrita "recordar", tal cual. `null` = no se ofrece. */
  suggestedRule: string | null;
}

/** Lo que se decide sin preguntar en una carpeta. */
export interface PermissionRule {
  id: string;
  cwd: string;
  /** `Bash(git status*)`, `Read`, `Edit(src/**)`. */
  pattern: string;
  allow: boolean;
  createdAt: number;
}

// ── Ruteo ──────────────────────────────────────────────────────────

export type Complexity = "trivial" | "standard" | "hard";

/**
 * Con qué criterio se asignó: lo nombró quien la lanzó (`manual`), salió a la primera del
 * tramo (`policy`), o hubo que descartar algo por el camino (`fallback`).
 */
export type RoutedBy = "manual" | "policy" | "fallback";

export interface QuotaWindow {
  /** De 0 a 1. */
  utilization: number;
  /** Epoch en segundos. Pasado ese momento, la ventana ya se reinició. */
  resetsAt: number | null;
}

/** Lo último que informó una tarea sobre el cupo de su cuenta. */
export interface Quota {
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
  rejected: boolean;
  rejectedUntil: number | null;
  overage: boolean;
  observedAt: number;
}

export interface RosterModel {
  /** Lo que recibe el flag de modelo de la TUI. */
  id: string;
  label: string;
  /** `false` = no puede trabajar como agente. `null` = no se sabe. */
  toolcall: boolean | null;
  local: boolean;
  /** USD por millón de tokens. */
  costIn: number | null;
  costOut: number | null;
  context: number | null;
  source: string | null;
  availability: "available" | "unavailable" | "unknown";
  reasoningLevels: string[] | null;
  defaultReasoning: string | null;
  /** El modelo ofrece el modo Fast de Codex. `null` = el catálogo no lo informa. */
  fastSupported?: boolean | null;
  unavailable: string | null;
}

export type ModelDiscoveryState = "available" | "unavailable" | "unsupported";

export interface RosterAccount {
  /** `null` = la del sistema. */
  accountId: string | null;
  key: string;
  name: string;
  label: string | null;
  loggedIn: boolean;
  quota: Quota | null;
  running: number;
  models: RosterModel[];
  modelDiscovery: ModelDiscoveryState;
}

export interface RosterAgent {
  capabilities: { headless: boolean; mcp: boolean; orchestration: boolean };
  agentId: string;
  label: string;
  installed: boolean;
  /** Se puede correr sin terminal. */
  launchable: boolean;
  unavailable: string | null;
  models: RosterModel[];
  modelDiscovery: ModelDiscoveryState;
  accounts: RosterAccount[];
}

/** Qué se puede lanzar ahora. */
export interface Roster {
  agents: RosterAgent[];
}

export interface ModelRef {
  agentId: string;
  model: string;
}

/** Qué modelos probar para cada complejidad, en orden. */
export type Tiers = Record<Complexity, ModelRef[]>;

export interface Assignment {
  agentId: string;
  /** `null` = el de siempre de la TUI. */
  model: string | null;
  reasoningEffort?: string | null;
  /** `null` = la del sistema. */
  accountId: string | null;
  routedBy: RoutedBy;
  notes: string[];
}

/** The nested delivery uses the versioned snake_case wire schema; Task uses camelCase. */
export interface StructuredHandoff {
  version: 1;
  summary: string;
  changed_files: { path: string; description?: string }[];
  tests: { command: string; status: "passed" | "failed" | "not_run"; notes?: string }[];
  decisions: string[];
  risks: string[];
  next_steps: string[];
  artifacts: { label: string; path: string }[];
  /** v1.1 (aditivo): `continue` exige next_steps, `complete` evidência, `blocked` um bloqueio. */
  status?: "continue" | "complete" | "blocked";
  evidence?: string[];
  blockers?: string[];
}
