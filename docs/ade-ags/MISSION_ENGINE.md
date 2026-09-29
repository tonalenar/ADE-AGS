# Mission Engine

## Auditoria (antes do v0)

Leitura de `src-tauri/src/runs/`, `database/schema.rs`, `app/run.rs` e `src/features/runs/` na base `01feebe`.

### O que já existe e NÃO será recriado

| Conceito | Onde vive | O que faz hoje |
| --- | --- | --- |
| Run | `runs/types.rs::Run`, tabela `runs` | Um lote de execução: `objective`, `cwd`, `status` (`running/done/failed/cancelled`), `max_parallel`, `budget_usd`, `spent_usd`. |
| Task | `runs/types.rs::Task`, tabela `tasks` | Uma unidade entregue a um agente headless: agente, conta, modelo, sessão, custo, worktree, `role`, `plan_key`, `parent_id`, `depth`, `handoff`. |
| Lead / worker | `types::role` | O lead planeja via MCP (`run_plan`, `task_add`); workers são tasks do plano. |
| DAG | tabela `task_deps`, `plan.rs` | Dependências validadas inteiras (chaves, ciclos, profundidade ≤ 2, ≤ 20 tasks). |
| Scheduler | `scheduler.rs` | `decide` puro + `tick` com lock; paralelismo, orçamento, skip por dependência quebrada. |
| Retry | `scheduler::should_retry` | Worker falho com sessão e sem estouro de budget volta à fila uma vez. |
| Reroute / handoff | `mod.rs::reroute_to`, `context::handoff_note` | Troca agente mantendo branch e o relato do anterior em `tasks.handoff`. |
| Facts | tabela `run_facts`, `context.rs` | Append-only por run, tratado como dado e não instrução. |
| Supervisor | `supervisor.rs` | Spawn do `HeadlessAgent`, `ProcessGroup` que mata a descendência, stream NDJSON, `finish_task`, eventos `cc-task-changed` / `cc-task-event` / `cc-task-approvals`. |
| Routing | `routing.rs`, `roster.rs` | Agente/modelo/conta por nome ou complexidade (tiers), conta automática por cota. |
| Worktrees | `worktrees.rs` | Um worktree por task isolada, criado ao despachar. |
| Provider Adapter | `agents/adapter.rs` | `adapter_for(id)` + `capabilities().headless`; o supervisor só lança quem tem `HeadlessAgent`. |
| Status do run | `store::refresh_run_status` | Derivado das tasks; chamado pelo scheduler, pelo cancelamento e pelo sweep de órfãos. |
| Início orquestrado | `run_start_orchestration` | Roteia, cria run + lead, dá ao lead as tools `Read/Note/Spawn`, lança pelo supervisor. |
| Cancelamento | `run_cancel_run` | Cancela pendentes, para as vivas pelo supervisor, recalcula o run. |
| UI | `FleetPage`, `RunStrip`, `NewTaskDialog` | Cards por task, faixa de runs orquestrados, diálogo com modo "orquestrar objetivo". |

### O que falta (e é o escopo do v0)

- Uma intenção durável que sobreviva a um run falho ou cancelado: hoje o `objective` morre junto com o run.
- Uma entidade em `draft`, revisável antes de gastar qualquer token. Hoje o único caminho orquestrado é "criar = lançar".
- Um lugar para ver essa intenção com seus runs, independente da Fleet.

Conclusão: a Mission fica **acima** de `runs/`. Não há segundo scheduler, segundo supervisor, segundo worktree nem segunda tabela de tasks.
