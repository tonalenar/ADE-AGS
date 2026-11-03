# Retomada e estado: armado após o reinício, integrantes `provisioning` e escopos de escrita

Três pontos da análise do `deepseek-harness` (MIT), seção (c): 15, 8 e 6. Os três tratam do que o app
sabe sobre o trabalho em andamento e do que ele faz sozinho com isso.

## 15. "Armado" não sobrevive ao reinício

**Problema.** Missão, time e rotina continuam `running` no banco depois que o app fecha. Ao reabrir, o
Vigia voltava a cutucar o lead de uma missão antiga (o "silencioso" dispara logo, porque a atividade dos
terminais é zerada), uma rotina com `--catch-up` disparava sozinha e o aviso de fechamento antecipado e o
"Decisão pendente" se repetiam, porque viviam só em memória.

**Regra.** O que foi armado **antes** do boot espera um gesto da pessoa: o botão **Retomar automação**. O
que nasce depois do boot (uma missão iniciada agora, um run novo, uma delegação nova num time de conversa)
é um gesto novo e roda normal. Não há CLI nem MCP para retomar: um agente não religa a própria supervisão.

| O quê | Antes do boot = | Pausado como | Onde |
|---|---|---|---|
| Vigia em missão | `missions.started_at` < boot | fica como com o Vigia desligado: só detecta "equipe entregou" | `src/features/missions/vigia.ts` |
| Vigia em time de conversa | a última tarefa delegada < boot | sem supervisão | idem |
| Rotina com catch-up | toda (`missed_at` é do fechamento) | não dispara; o prazo de 15 min conta de quando a pessoa retoma | `ipc/commands/routine.rs` |
| Rodada de correção automática da frota | `runs.created_at` < boot | a tarefa fica `failed`, sem rodada aberta | `runs/fixrounds.rs::on_worker_failure_at` |

As tarefas que estavam rodando já eram encerradas no boot (`runs::sweep_orphans`); o painel conta as que
eram rodada de correção (`fix_round > 0`), mas elas **não** voltam nem com o botão: o lead delas morreu com
o app. A pessoa as reabre pela Frota.

**Estado.** Só do processo (`missions/automation.rs`): o instante do boot (`mark_boot`, no arranque) e o de
quando a pessoa retomou. O próximo boot pausa de novo o que estiver armado. Comandos `automation_status` e
`automation_resume`; evento `cc-automation-changed`. No front, `src/features/missions/automation.ts`: até a
resposta do backend chegar, tudo de antes de agora conta como pausado (falha fechada); com um backend sem o
comando, nada pausa.

**Onde aparece.** `AutomationResumeBar` no topo de Missões e no QG (BotPanel), e um botão ▶ ao lado do olho
do Vigia na barra do canvas. A barra lista as equipes (do backend e as que o Vigia pulou), as rotinas a
recuperar e as rodadas interrompidas.

**Aviso repetido ao reabrir.** O `Watch` de `ags.vigia.watches.v1` (que expira em 3 dias) agora guarda
também `closingAt`/`closingCount` (fechamento antecipado) e `decisionRound` ("Decisão pendente"). O campo é
opcional: o armazenamento antigo continua válido. Continuam voláteis `lastPoke`, `inFlight`,
`lastErrorReport`, `pokes` e `loops` (o laço do Codex leva 8 min para ser redetectado).

## 8. Integrante `provisioning` antes do spawn, reconciliado no boot

**Problema.** Se o app caísse entre criar o worktree e subir o agente, sobrava um órfão sem estado: nada
dizia se aquele integrante chegou a abrir.

**Missão em terminais** (`missions/members.rs`, tabela `mission_member_state`):
- `mission_prepare_team` grava cada integrante como `provisioning` **antes** do worktree; se a preparação
  falha, ele fica `failed`, com o motivo. Um retry da equipe volta a `provisioning` só quem falhou.
- `ags peer recruit` grava o recrutado antes do worktree e **recusa um nome que a missão já usou** (ativo,
  falho ou que saiu; maiúsculas não contam). Antes, recrutar "Ana" de novo reabria o worktree e a branch da
  primeira.
- `provisioning` → `active` quando chega um span de início com o nome dele (`boot`, `start_briefing`,
  `start_activity`) ou quando a `startcheck` acha uma aba na pasta dele.
- **No boot** (`app/housekeeping.rs`, só sem outra instância aberta), quem ficou `provisioning` vira `active`
  (há aba guardada ou registrada na pasta, ou span de início) ou `failed` ("o app fechou antes de o worktree
  ficar pronto" / "depois de criar o worktree e antes de o agente abrir"). Nada é apagado: o worktree que
  sobrou continua no disco (`ags worktrees list`).
- `ags mission startcheck` mostra `state` e `failure` de cada integrante.

**Time do modo chat** (`chat_team/store.rs`, tabela `chat_team_provision`; `chat_team/api.rs`):
- `spawnMember` chama `chat_team_provision_begin` **antes** do worktree e da conversa; o backend devolve o nome
  único entre todos os que o time já teve ("Codex · QA", depois "Codex · QA 2").
- `chat_team_link` com `provision` liga e marca `active`; erro ao abrir, ao ligar ou conversa fechada antes
  de ligar marcam `failed` (`chat_team_provision_fail`).
- No boot, `reconcile_provisions`: a conversa está no time → `active`; senão `failed`, com o motivo.
- A sidebar mostra quem está "entrando no time…" e quem "não entrou: <motivo>". O teto de 12 conta quem
  ainda está entrando.

### Migração (aditiva; nenhum dado apagado)
- `mission_member_state (mission_id, name, state, failure, created_at, updated_at)`, PK `(mission_id, name)`,
  `CHECK(state IN ('provisioning','active','failed'))`, `ON DELETE CASCADE` com a missão. Em `database/schema.rs`,
  `CREATE TABLE IF NOT EXISTS`, sem subir o `user_version` (como os outros acréscimos recentes).
- `chat_team_provision (id, team_id, label, agent_id, role, member, worktree, branch, state, failure,
  created_at, updated_at)` e um índice, no `migrate()` próprio de `chat_team/store.rs`, `IF NOT EXISTS`.
  Desfazer o time (só a pessoa) apaga as linhas dele junto com os integrantes, como já acontecia com eles.
- Nenhuma coluna existente muda; missões antigas não têm linhas e continuam funcionando (a `startcheck`
  omite `state`; os nomes delas ficam reservados pelo `mission_team_workspaces`).

## 6. Escopos de escrita (`writeScopes`) e o aviso de sobreposição

Cada tarefa delegada pode declarar os prefixos de caminho que vai tocar. Quando duas tarefas **em
andamento** de donos diferentes se sobrepõem, o canvas e o QG avisam. **Só aviso: nada é bloqueado.** A
tarefa sem escopo fica fora da conta (não se adivinha o que ela vai tocar).

- **Na delegação** (missão em terminais e time do chat): uma linha `Escopo: src/features/chat/, src-tauri/src/chat_team/`
  (também `Escopos:`, `Escopo de escrita:`, `Write scopes:`), separada por vírgula, `;` ou espaço. O briefing
  do lead pede essa linha (`terminals.ts`).
- **No plano da frota** (`run_plan`): o campo `write_scopes` de cada tarefa (`runs/plan.rs`). Um escopo
  inválido (absoluto, com `..` ou com curinga no meio) recusa o plano inteiro. O app grava a linha `Escopo:`
  no prompt da tarefa, e a resposta do `run_plan` traz o aviso quando há sobreposição.
- **Normalização** (`missions/conflicts/scopes.rs`): relativo ao repositório, `/`, sem `./` nem barra no fim;
  `src/**` vale `src`; `.` é o repositório inteiro. A sobreposição é por componente: `src/a` cobre
  `src/a/b.ts`, mas não `src/ab`.
- **Em andamento**: numa missão, a última delegação com escopo que cada aba recebeu até ela entregar
  (`ags peer deliver`), mais as tarefas `pending`/`ready`/`running` da frota da missão; uma tarefa nova sem
  escopo (`Tarefa:` sem `Escopo:`) encerra a anterior. No time do chat, o mesmo sobre o fio orquestrador ↔
  integrantes.
- **Telas**: `MissionScopeOverlaps` no painel do time no canvas (acima do fio), em Missões e no QG;
  `ChatTeamScopeOverlaps` no painel do time do modo chat. Recarrega a cada `cc-peer-message`.
- **Comandos**: `mission_scope_overlaps(missionId)` e `chat_team_overlaps(teamId)`.

## Testes
- Rust: `missions/automation.rs` (portão e status), `runs/fixrounds.rs`
  (`a_rodada_automatica_de_um_run_de_antes_do_boot_espera_a_pessoa_retomar`), `missions/members.rs`
  (reconciliação, retry, nome não reutilizado), `chat_team/test.rs` (provisioning, boot, teto, nome único,
  sobreposição no fio), `missions/conflicts/scopes.rs` (normalização, sobreposição, leitura do banco).
- Front: `src/features/missions/tests/vigiaRestart.test.ts` (sem cutucada antes de retomar; o "Decisão
  pendente" não se repete ao reabrir; os dois falham no `vigia.ts` antigo) e `tests/automation.test.ts`.

## Pendências
- O Vigia do chat por protocolo (`chat_team/watch.rs`) ainda avisa o orquestrador depois do reinício sem
  esperar o botão: pode usar `missions::automation::paused_for(...)` com o instante do time.
- A tool `run_plan` do MCP (`ipc/mcp.rs`) ainda não descreve `write_scopes` no schema; o campo já é aceito.
- Não há tela que liste os integrantes `failed` de uma missão fora da `startcheck`.
