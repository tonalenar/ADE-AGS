# Failover do pool de contas

Antes desta etapa, uma tarefa roteada por `pool:<nome>` ficava fixada na conta que o pool escolheu: se ela estourasse o cupo
no meio da tarefa, a tarefa falhava e ninguém tentava a próxima conta do mesmo pool
(`routing::AccountChoice::Pool` sempre marcava `auto_account: false`, então
`scheduler::on_account_failure` tratava a tarefa como fixada e nunca a reroteava).

## O que é

Um interruptor **opcional, desligado por padrão** em cada pool (`Pool.failover`). Com ele
ligado, uma tarefa **headless** (flota, não terminal interativo) que falha por limite, autenticação, modelo indisponível ou assinatura/saldo ganha UMA tentativa na próxima conta elegível do MESMO pool, em vez de falhar direto.

Sem o opt-in, nada muda: o comportamento é idêntico ao de antes desta etapa.

## Limites (todos obrigatórios, todos com teste)

| Limite | Valor | Onde é aplicado |
|---|---|---|
| Failovers por tarefa | no máximo 1 | `pool_failover::reserve_failover` (chave `runs.pool_failover.<task_id>` em `settings`) |
| Failovers por pool | no máximo 3 por hora, janela deslizante | `pool_failover::reserve_failover` (chave `runs.pool_failover.pool.<pool_id>`, lista de timestamps podada a cada checagem) |
| Cooldown da conta que estourou | 30 minutos sem ser escolhida de novo | `pool_failover::cool_down_account`/`account_in_cooldown` (em memória), checado dentro de `routing::pick_in_pool` |
| Motivo que aciona o failover | `RateLimited`, `AuthExpired`, `ModelUnavailable`, `InsufficientBalance` | `pool_failover::failure_eligible`; nunca `Other` (código, crash, timeout, permissão de arquivo) |
| Escopo da conta de destino | só contas do MESMO pool e do MESMO agente/TUI | `routing::pick_in_pool` (reaproveitado, não reimplementado) |
| Contas nunca escolhidas | sem login, com `limit` (bloqueio/ban/verificação pendente), ou em cooldown | `routing::account_problem` + o cooldown acima, ambos já dentro de `pick_in_pool` |
| Só sobrou a mesma conta | não faz failover; tarefa falha como antes | `failover_in_pool` retorna erro se a conta escolhida pelo ruteiro for igual à original |
| Terminais interativos (TUI) | nunca trocam de conta sozinhos | o failover só roda no caminho da flota (`runs::scheduler`); tabs interativas não passam por ali |

Nenhum destes limites tem tabela nova nem migração de schema: tudo guardado em `settings` por
chave, no mesmo padrão de `accounts.limits.<key>` e `runs.auth_failed.<key>` que já existiam.

## Isolamento de contas

O failover troca **qual conta** (perfil já isolado) a tarefa usa, pelo mesmo mecanismo que
`routing::route` + `runs::reroute_to` já usavam para o ruteio automático (`AccountChoice::Auto`).
A nova seleção usa somente o roster/catálogo já expostos pela app. Não copia nem compartilha credenciais ou perfis entre contas, e não toca
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
`kind: "rate_limited" | "auth" | "model" | "balance"`, `fromModel`, `toModel`), do mesmo jeito que `account.failure` já fazia para o ruteio automático.
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

## Etapa 10: acesso, modelo e saldo

A seleção pura `pool_failover::replacement` exclui a conta de origem e contas de fora do pool, respeita login, limite, cooldown e estratégia existentes e consulta o catálogo de cada conta. Tenta preservar o modelo. Só um erro classificado como modelo permite mudar para outro modelo com disponibilidade confirmada no catálogo da conta de destino; erros de login/saldo não alteram um modelo explícito. O toast pt-BR/en/es mostra motivo e modelo escolhido.

Sem alternativa elegível, com opt-in desligado ou após uma troca, a tarefa permanece falhada com a ação do erro. A reserva atômica de 1 por task / 3 por pool-hora continua antes do reroute. O cooldown é de 30 minutos. O caminho de terminais não chama o scheduler e não recebe failover. A classificação diferencia erros do provedor de números em caminhos/linhas de código.

## Pool de contas no chat (conversas por protocolo)

O failover acima é da frota headless. No modo chat, uma conversa por protocolo (`conversa/`) também troca de conta quando a dela esgota o limite (`conversa/pool.rs`).

### Regras

| Regra | Como |
|---|---|
| Desligado por padrão | `settings` `chat.pool.mode` = `off` (padrão) \| `ask` \| `auto`. Só a pessoa muda (Contas → Pools). O agente, a CLI e mensagens de peers não ligam |
| Só com pool escolhido | a conversa criada com `pool:<nome>` fica ligada ao pool (`chat.pool.thread.<id>`). Sem pool, não troca. O backend resolve `pool:<nome>` em `api::create` (antes o valor ia cru para `account_id`) |
| Gatilho | fim de turno com erro classificado `RateLimited` por `runs::failure::classify` (reuso: «hit your limit», «5-hour limit»…). Auth, modelo e outros erros nunca trocam |
| Escolha da conta | `routing::pick_in_pool` sobre o roster: mesmo agente, logada, sem limite/orçamento estourado, fora do cooldown. A conta que esgotou entra no cooldown de 30 min e é marcada como esgotada até a renovação (`runs.quota.*`), então a frota também a evita |
| Tetos | no máximo 3 trocas por hora por conversa; nunca encadeia (conta nova esgotando em até 5 min para e avisa) |
| `ask` | aviso `poolAsk` na timeline com «Continuar na outra conta» / «Agora não» (pendência em `chat.pool.pending.<id>`) |
| `auto` | troca e avisa (`poolSwitch`); sem conta livre, `poolBlocked` com o motivo |
| Volta | quando a hora de renovação da conta original passa, a próxima mensagem da pessoa (conversa livre) volta a ela: `auto` volta e avisa; `ask` pergunta (`poolReturnAsk`). Nunca no meio de um turno |
| Renovação | `reset_at` lê «resets 1:10pm» no fuso do sistema; sem hora legível, vale 5 h |

### Continuidade: handoff por resumo

A sessão do agente mora no perfil da conta (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`): `--resume` de outra conta não acha a sessão. Por isso a troca fecha o processo parado, passa `chat_thread.account_id` para a conta nova, **zera `remote_id`** e manda como primeira mensagem um resumo (`handoff_text`: as últimas 12 falas e o pedido sem resposta) marcado como DADO, nunca instrução. Não copia transcript nem credencial entre perfis. Copiar o transcript para o `--resume` achar a sessão ficou **não implementado** (experimento futuro, só atrás de flag e validado em instância isolada).

### Segurança e política

- Nenhum segredo novo: só ids de conta em `settings`; credenciais continuam no perfil/keyring. Nenhuma migração (só chaves em `settings`, e `set_account`/`clear_remote_id` sobre colunas existentes).
- **Ressalva de política:** alternar contas para contornar limite pode violar os termos do provedor. O pool serve a contas da própria pessoa, cada uma com o plano dela; a tela de ativação avisa e toda troca fica registrada na conversa.
- Aba de terminal (TUI): nunca troca nem digita. Ainda não há oferta de abrir aba nova com o resumo (pendente).

### Onde

Backend: `conversa/pool.rs` (pura: `decide`, `reset_at`, `can_return`, `recent`, `handoff_text`; app: `after_turn`, `accept`, `before_send`), ganchos em `turn::finish` e `claude::finish_turn`, comandos `chat_pool_pending|accept|dismiss`. Frontend: `accounts/chatPool.ts`, `ChatPoolMode.tsx`, `chat/timeline/NoticeRow.tsx` (`PoolNotice`). Testes: `conversa/pool_test.rs`, `accounts/tests/chatPool.test.ts`, `chat/tests/noticeRow.test.tsx`.
