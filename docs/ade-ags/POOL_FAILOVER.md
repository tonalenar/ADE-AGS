# Failover do pool de contas

Antes desta etapa, uma tarefa roteada por `pool:<nome>` ficava fixada na conta que o pool escolheu: se ela estourasse o cupo
no meio da tarefa, a tarefa falhava e ninguém tentava a próxima conta do mesmo pool
(`routing::AccountChoice::Pool` sempre marcava `auto_account: false`, então
`scheduler::on_account_failure` tratava a tarefa como fixada e nunca a reroteava).

## O que é

Um interruptor **opcional, desligado por padrão** em cada pool (`Pool.failover`). Com ele
ligado, uma tarefa **headless** (flota, não terminal interativo) que falha por cupo esgotado ou
rate limit ganha UMA tentativa na próxima conta elegível do MESMO pool, em vez de falhar direto.

Sem o opt-in, nada muda: o comportamento é idêntico ao de antes desta etapa.

## Limites (todos obrigatórios, todos com teste)

| Limite | Valor | Onde é aplicado |
|---|---|---|
| Failovers por tarefa | no máximo 1 | `pool_failover::reserve_failover` (chave `runs.pool_failover.<task_id>` em `settings`) |
| Failovers por pool | no máximo 3 por hora, janela deslizante | `pool_failover::reserve_failover` (chave `runs.pool_failover.pool.<pool_id>`, lista de timestamps podada a cada checagem) |
| Cooldown da conta que estourou | 30 minutos sem ser escolhida de novo | `pool_failover::cool_down_account`/`account_in_cooldown` (em memória), checado dentro de `routing::pick_in_pool` |
| Motivo que aciona o failover | só `FailureKind::RateLimited` (cupo/rate limit) | `pool_failover::failure_eligible` — nunca para `AuthExpired` (credencial/login) nem `Other` (erro de código, timeout, permissão negada) |
| Escopo da conta de destino | só contas do MESMO pool e do MESMO agente/TUI | `routing::pick_in_pool` (reaproveitado, não reimplementado) |
| Contas nunca escolhidas | sem login, com `limit` (bloqueio/ban/verificação pendente), ou em cooldown | `routing::account_problem` + o cooldown acima, ambos já dentro de `pick_in_pool` |
| Só sobrou a mesma conta | não faz failover; tarefa falha como antes | `failover_in_pool` retorna erro se a conta escolhida pelo ruteiro for igual à original |
| Terminais interativos (TUI) | nunca trocam de conta sozinhos | o failover só roda no caminho da flota (`runs::scheduler`); tabs interativas não passam por ali |

Nenhum destes limites tem tabela nova nem migração de schema: tudo guardado em `settings` por
chave, no mesmo padrão de `accounts.limits.<key>` e `runs.auth_failed.<key>` que já existiam.

## Isolamento de contas

O failover só troca **qual conta** (perfil já isolado) a tarefa usa, pelo mesmo mecanismo que
`routing::route` + `runs::reroute_to` já usavam para o ruteio automático (`AccountChoice::Auto`).
Ele nunca copia, lê, move ou compartilha credenciais, tokens ou perfis entre contas, e não toca
`~/.ags/accounts` nem os perfis.

## De onde vem a origem do pool de uma tarefa

Uma conta pode pertencer a mais de um pool, então não dá para inferir "de qual pool veio essa
tarefa" só pela conta escolhida. A origem (`PoolOrigin { id, name, agent_id }`) viaja na
`Assignment` do ruteio e é persistida em `settings` (`runs.task_pool.<task_id>`, sem coluna nova
em `tasks`) nos três pontos onde uma tarefa nasce ou troca de mãos: `run_start_task`,
`plan_tasks` e `reroute_to` (`runs/mod.rs`, `runs/orchestration.rs`).

## Auditoria e aviso

Todo failover bem-sucedido publica `account.pool_failover` no barramento de eventos
(`taskId`, `runId`, `poolId`, `poolName`, `fromAccount`, `toAccount`, `reason`,
`kind: "rate_limited"`), do mesmo jeito que `account.failure` já fazia para o ruteio automático.
`notifier.rs` escuta esse tópico e mostra um aviso do sistema operacional (pt-BR/en/es), e o
app mostra um toast equivalente (`PoolFailoverNotice.tsx`).

## O que ficou de fora

O item original também pedia que um terminal interativo (TUI) **avisasse preventivamente** o
usuário quando sua própria conta estourasse, sugerindo trocar para outra conta do pool. Não foi
implementado: não existe hoje, no código de tabs interativas, um ponto que classifique o motivo
de uma falha (cupo vs. erro) da mesma forma que `runs::failure::classify` faz para a flota — e
inventar um atalho só para fechar esse item teria sido um risco não coberto por teste. Em vez
disso, o aviso acima é só de **auditoria** (o que já aconteceu numa tarefa headless), e o
terminal interativo continua sem nenhuma troca ou sugestão automática.

## Onde

- Backend: `src-tauri/src/accounts/pools.rs` (`Pool.failover`, `PoolOrigin`, `PoolSpec`),
  `src-tauri/src/runs/pool_failover.rs` (limites), `src-tauri/src/runs/routing.rs`
  (`pick_in_pool` respeita cooldown), `src-tauri/src/runs/scheduler.rs`
  (`on_account_failure`/`failover_in_pool`), `src-tauri/src/notifier.rs`,
  `src-tauri/src/ipc/commands/pool.rs` (`pool_set_failover`).
- Frontend: `src/features/accounts/pools.ts`, `src/features/accounts/PoolsSection.tsx`
  (interruptor), `src/features/accounts/PoolFailoverNotice.tsx` (toast), `src/i18n/locales/*`
  (chaves `accounts.pools.failover*`).
- Testes: `src-tauri/src/runs/pool_failover/test.rs` (um teste por limite),
  `src/features/accounts/tests/pools.test.ts`.
