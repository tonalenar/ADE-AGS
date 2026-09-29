# Mission Engine

**Mission Engine = domínio. Mission Runtime = execução e coordenação.**

Este documento é o domínio: a Mission persistida, seus estados e comandos. Como ela roda (launcher, política do lead, aprovações, eventos, progresso) está em [MISSION_RUNTIME.md](./MISSION_RUNTIME.md).

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

## Modelo (v0)

```text
Workspace → Mission → Run → Task → Agent
```

| Entidade | É | Vive em |
| --- | --- | --- |
| Mission | A intenção durável: título, objetivo, pasta, preferência de lead e de conta, paralelismo, orçamento. | `missions/`, tabela `missions` |
| Run | Uma tentativa de cumprir a Mission. | `runs/`, tabela `runs` (`mission_id` nullable) |
| Task | Uma unidade entregue a um agente (lead ou worker). | `runs/`, tabela `tasks` |
| Agent | O processo headless de um provider. | `agents/` + `runs/supervisor.rs` |

### Banco

Migração 18 → 19, só aditiva:

- `missions`: `id`, `workspace_id` (FK, `ON DELETE CASCADE`), `title`, `objective`, `cwd`, `status`, `max_parallel`, `budget_usd`, `lead_agent_id`, `lead_model`, `lead_account_id`, `auto_account`, `complexity`, `active_run_id` (FK `runs`, `ON DELETE SET NULL`), `created_at`, `updated_at`, `started_at`, `ended_at`. Índice por workspace.
- `runs.mission_id` (FK `missions`, `ON DELETE SET NULL`) com índice. Runs antigos ficam com `NULL` e continuam funcionando; nenhum vira Mission.
- Várias linhas de `runs` podem apontar para a mesma Mission. O v0 só cria uma, mas o banco não impede o retry futuro.

### Conta: preferência, nunca credencial

A Mission guarda `lead_account_id` (o id de uma conta já cadastrada) ou `auto_account = 1`. Nunca token, nunca ambiente, nunca cópia de configuração. A credencial continua sendo resolvida pelo mesmo caminho da frota no momento do Start (`routing` → `supervisor` → diretório da conta). Com `auto_account`, qualquer `lead_account_id` enviado é descartado.

## Responsabilidades

| Quem | Faz | Não faz |
| --- | --- | --- |
| `missions::store` | CRUD, validação, regra de edição, `mark_started`, `refresh_for_run`. | Lançar processos. |
| `missions::start` | Valida draft, pasta e provider; roteia; chama `runs::start_orchestration` com `mission_id`; marca `running` na mesma transação que cria run + lead. | Ter scheduler ou supervisor próprio. |
| `missions::cancel` | Draft: marca `cancelled`. Running: chama `runs::cancel_run` do run ativo. | Matar processos por conta própria. |
| `runs::start_orchestration` | Função única de início orquestrado, usada pela Fleet (`run_start_orchestration`) e pela Mission. | Saber o que é uma Mission além de gravar `mission_id`. |
| `runs::store::refresh_run_status` | Recalcula o run e, no fim, chama `missions::store::refresh_for_run`: é o **único** ponto que move o status da Mission. | — |
| Supervisor, scheduler, routing, worktrees | Continuam exatamente como antes. | — |
| Provider Registry | `ensure_headless` usa `adapter_for(id)` + `capabilities().headless`. Sem `if claude` / `if codex`. | — |

## Estados

`draft`, `running`, `done`, `failed`, `cancelled`. Sem `paused` nem `planning`.

```text
draft ──Start──▶ running ──run done──▶ done
  │                 ├──run failed──▶ failed
  │                 └──Cancel / run cancelled──▶ cancelled
  └──Cancel──▶ cancelled
```

- Start é atômico: run, task lead e `status = running` entram na mesma transação. Se o lead não consegue ser lançado depois do commit, a task lead fica `failed` com o erro, o run é recalculado para `failed` e a Mission o acompanha. Nunca há Mission `running` sem run.
- Start duplo: o segundo encontra `status != draft`, `mark_started` retorna falso e a transação volta atrás.
- Só o run ativo (`active_run_id`) move a Mission. Um run antigo que termina depois não mexe nela.
- Edição: em `draft` tudo pode mudar; fora de `draft`, só o título. Outra mudança é recusada.
- Criar ou editar nunca lança nada: nenhum PTY, processo headless ou worktree. Há teste que conta os três antes e depois.

## Comandos

`mission_create`, `mission_update`, `mission_list`, `mission_get`, `mission_start`, `mission_cancel`.

## UI

Rota modal `#/missions`, botão na barra lateral abaixo da Fleet. Lista (título, status, pasta, lead, data, gasto, progresso dos workers), formulário de criação/edição e detalhe (objetivo, provider, conta, orçamento, gasto, run atual, lead à parte, tasks, dependências, estado dos agentes, aprovações pendentes, resultado/erro, facts do run ativo). Ações: draft → Iniciar; running → Cancelar; finalizada → nenhuma. Atualiza por `cc-task-changed` e `cc-mission-changed`, com refresh coalescido; sem polling. Desde o v0.1, ver [MISSION_RUNTIME.md](./MISSION_RUNTIME.md).

## O que o v0 NÃO faz

- Retry, rerun, clone, duplicar, arquivar ou apagar Mission.
- Worktree por Mission (continua o worktree por task isolada da frota).
- Maestro, Roles, Squads, Shared Memory, Map Mode, sub-missions, templates, cron, automações, cloud/sync/colaboração.
- Facts por Mission: a Mission mostra os facts do run ativo.
- Handoff estruturado: o `tasks.handoff` só é exibido.
- Estimativa de custo ou usage universal.

## Débito técnico do v0 (resolvido no v0.1)

Todos tratados em `fix/mission-runtime-v01`; detalhe em [MISSION_RUNTIME.md](./MISSION_RUNTIME.md).

- ~~Não existe evento `mission-changed`~~ → `cc-mission-changed` em create, update, start, status final e cancel.
- ~~A contagem "n / m tarefas" inclui o lead~~ → progresso só de workers, lead à parte, "Lead planejando" sem workers.
- ~~Aprovações pendentes só aparecem na Fleet~~ → a tela de Missions mostra a mesma fila do broker, com Allow/Deny/Remember.
- ~~Windows: `codex.cmd` / `opencode.cmd` falham com prompt multi-linha~~ → `util::external_command` lança o alvo real do shim npm, sem `cmd.exe`.
- ~~O prompt de lead não impede o modelo de agir sozinho~~ → política do lead imposta no broker e na CLI de cada provider; o prompt manda delegar tudo.

## E2E (29/09/2026, Windows, build release)

Repo git descartável em `%TEMP%\ade-mission-e2e`, Mission "Criar um arquivo hello.txt contendo ADE AGS", conduzida pela UI real (WebView2 com remote debugging):

1. Criar pelo formulário → draft; zero processos filhos da ADE, zero worktrees, nenhum arquivo novo.
2. Start → run criado e atado, um único lead headless.
3. Três tentativas falharam por ambiente, e cada uma terminou em Mission/run/lead `failed` com o erro visível: Claude haiku (403 do gateway free tier), Codex (`batch file arguments are invalid`), Claude sem modelo (modelo padrão inválido em headless).
4. Quarta tentativa: Claude Code com `claude-code/spacexai/grok-build-0.1` → `hello.txt` com `ADE AGS`, commit local; aprovações concedidas manualmente (Write, leitura, commit), push negado. Mission `done`, 1 / 1, US$ 0,115.
5. ADE fechada e reaberta → as quatro Missions visíveis com status, gasto e resultado.
