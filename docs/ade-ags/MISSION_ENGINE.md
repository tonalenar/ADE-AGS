# Mission Engine

**Mission Engine = domínio. Mission Runtime = execução e coordenação.**

Este documento é o domínio: a Mission persistida, seus estados e comandos. Como ela roda (launcher, política do lead, aprovações, eventos, progresso) está em [MISSION_RUNTIME.md](./MISSION_RUNTIME.md). O roteamento por equipes reutilizáveis está em [ROLES_SQUADS.md](./ROLES_SQUADS.md).

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
Workspace → Mission → Squad opcional → Run → Task → Agent
```

| Entidade | É | Vive em |
| --- | --- | --- |
| Mission | A intenção durável: título, objetivo, pasta, modo de execução, Squad opcional, paralelismo, orçamento. | `missions/`, tabela `missions` |
| Squad | Configuração reutilizável de Lead e roteamento por Role funcional. | `squads`, `squad_members` |
| Run | Uma tentativa de cumprir a Mission. | `runs/`, tabela `runs` (`mission_id` nullable) |
| Task | Uma unidade entregue a um agente (lead ou worker). | `runs/`, tabela `tasks` |
| Agent | O processo headless de um provider. | `agents/` + `runs/supervisor.rs` |

### Banco

Migração 18 → 19, só aditiva:

- `missions`: `id`, `workspace_id` (FK, `ON DELETE CASCADE`), `title`, `objective`, `cwd`, `status`, `max_parallel`, `budget_usd`, `lead_agent_id`, `lead_model`, `lead_account_id`, `auto_account`, `complexity`, `active_run_id` (FK `runs`, `ON DELETE SET NULL`), `created_at`, `updated_at`, `started_at`, `ended_at`. Índice por workspace.
- `runs.mission_id` (FK `missions`, `ON DELETE SET NULL`) com índice. Runs antigos ficam com `NULL` e continuam funcionando; nenhum vira Mission.
- Várias linhas de `runs` podem apontar para a mesma Mission. Uma missão `failed` pode ser reenviada por **Tentar novamente**, criando um novo Run e Lead sem alterar o objetivo ou apagar os dados dos runs anteriores.

Schema v20 adiciona `missions.squad_id` nullable, configuração persistente de Squads, snapshot por Run e `tasks.functional_role` nullable. Dados de Mission/Run/Task anteriores ficam sem Squad/Role funcional e preservam o routing anterior. Consulte [ROLES_SQUADS.md](./ROLES_SQUADS.md) para tabelas, constraints e resolução.

### Modos de execução

Um draft escolhe Automatic routing, Specific provider ou Squad. Automatic mantém tiers/complexity; Specific mantém provider/model/account explícitos; Squad escolhe o Lead configurado no Squad e resolve workers pelo functional role do plano. Os campos são enviados sem combinações contraditórias e o backend rejeita overrides manuais de Lead ou worker quando Squad é a autoridade.

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
failed ──Tentar novamente──▶ running (novo run)
```

- Start é atômico: run, task lead e `status = running` entram na mesma transação. Se o lead não consegue ser lançado depois do commit, a task lead fica `failed` com o erro, o run é recalculado para `failed` e a Mission o acompanha. Nunca há Mission `running` sem run.
- Start ou retry duplo: `mark_started` compara o estado e o `active_run_id` lidos antes do roteamento. Se outra execução venceu, a transação do pedido desatualizado volta atrás sem lançar o Lead. A proteção também vale quando a execução concorrente já terminou em falha.
- Só o run ativo (`active_run_id`) move a Mission. Um run antigo que termina depois não mexe nela.
- Edição: em `draft` tudo pode mudar; fora de `draft`, só o título. Outra mudança é recusada.
- Criar ou editar nunca lança nada: nenhum PTY, processo headless ou worktree. Há teste que conta os três antes e depois.

## Comandos

`mission_create`, `mission_update`, `mission_list`, `mission_get`, `mission_start`, `mission_cancel`.

## Shared Memory v0

Shared Memory é uma camada local de contexto aprovada pelo usuário, separada do estado da Mission e dos fatos temporários do Run. Workspace Memory é compartilhada no workspace; Mission Memory pertence a uma única Mission. No Start e em cada retry, `runs::start_orchestration` seleciona as entradas aprovadas e grava um snapshot imutável na mesma transação que cria o Run e o Lead. Editar ou excluir uma memória depois não altera Runs antigos nem o snapshot de um Run em andamento.

Lead e Worker podem consultar memória e criar propostas de criação, atualização, tombstone ou promoção de Run Fact. A Task, o Run, a Mission e o Workspace são resolvidos pelo backend; o modelo não informa owners. Propostas ficam `proposed` até o usuário aprovar ou rejeitar na tela. Atualização e exclusão usam `expected_revision` e não substituem a revisão ativa antes da aprovação. O contrato completo, migration v24, quotas e testes está em [SHARED_MEMORY.md](./SHARED_MEMORY.md).

## UI

Rota modal `#/missions`, botão na barra lateral abaixo da Fleet. Lista (título, status, pasta, lead, data, gasto, progresso dos workers), formulário de criação/edição e detalhe (objetivo, modo de execução, Squad/snapshot, provider, conta, orçamento, gasto, run atual, lead à parte, tasks com Role funcional, dependências, estado dos agentes, aprovações pendentes, resultado/erro, facts do run ativo). Ações: draft → Iniciar; running → Cancelar; failed → Tentar novamente; done/cancelled → nenhuma. O retry reutiliza a configuração da Mission e resolve novamente a conta e o Squad atuais. Tasks, facts, erros e custos anteriores permanecem associados aos seus runs; o detalhe mostra o novo run ativo e a contagem de execuções. Atualiza por `cc-task-changed` e `cc-mission-changed`, com refresh coalescido; sem polling. Desde o v0.1, ver [MISSION_RUNTIME.md](./MISSION_RUNTIME.md).

## Revisão das entregas e worktree de integração

Cada task isolada continua no seu worktree e branch (`cc/<task>`). O detalhe da Mission ganhou a seção **Revisão das entregas** (`missions/review.rs`, `MissionReviewPanel.tsx`), que mostra para cada task do run ativo:

- os commits;
- os arquivos com +/−;
- o diff contra o HEAD do projeto;
- as mudanças que ficaram sem commit.

As ações:

- **Aceitar** faz `merge --no-ff` da branch da task no **worktree de integração** da Mission.
  - Ele é criado na primeira aceitação, a partir do HEAD do projeto, e fica em `missions.integration_branch` / `integration_path`.
  - A cópia de trabalho do usuário não é tocada.
  - É recusado com a task viva ou com mudanças sem commit no worktree dela, porque essas mudanças não estão na branch.
- **Rejeitar** só marca a task (`tasks.review`).
- **Aplicar no projeto** faz um único `merge --no-ff` da branch de integração na branch atual do projeto.
  - É recusado com HEAD desprendido ou com mudanças rastreadas sem commit.
  - Arquivos não rastreados não impedem a aplicação.

Um merge que dá conflito, na integração ou no projeto, é sempre abortado. Os arquivos em conflito voltam no resultado. Nenhum passo deixa um repositório no meio de um merge. Resolver o conflito fica com quem revisa: à mão, ou reencaminhando a task a um agente. A implementação não usa `git merge-tree --write-tree` (2.38+), então funciona com o git 2.34 do CI.

## O que o v0 NÃO faz

- Rerun de missão concluída ou cancelada, clone, duplicar, arquivar ou apagar Mission.
- Shared Memory, Map Mode, sub-missions, templates, cron, automações, cloud/sync/colaboração.
- Facts por Mission: a Mission mostra os facts do run ativo.
- Handoff estruturado: o `tasks.handoff` continua em texto livre e só é exibido.
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

Shared Memory v0 está **implementada e validada na PR #4 (`feat/shared-memory-v0`), aguardando merge**, com gates e E2E real concluídos em 01/10/2026: retry, MCP, Fact, handoff, proposta aprovada pelo usuário e persistência após restart. Commits e push realizados; PR #4 aberta, ainda não mergeada. Ver [SHARED_MEMORY.md](./SHARED_MEMORY.md).
