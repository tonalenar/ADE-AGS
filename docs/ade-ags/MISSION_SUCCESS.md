# Sucesso das missões

## Checagem antes de lançar (etapa 10, ponto 1)

O precheck reaproveita o roster e o catálogo por conta antes de lançar. A atribuição do lead e o início em terminais validam instalação, sessão exposta pela app, limite e disponibilidade do modelo na conta escolhida antes de criar run ou marcar início. A nova checagem não lê arquivos de credenciais.

Catálogo com descoberta confirmada rejeita modelo ausente; descoberta desconhecida permanece desconhecida. Sessão e uso são os estados já expostos pelo roster: não garantem que um login não expire após a checagem, nem saldo de provedores sem consulta de limite. Erros possuem ações em pt-BR/en/es. A checagem anterior de código/histórico continua no briefing.

Revisão QA: terminais com conta automática exigem estado de login da conta principal; a ausência de conta padrão não é tratada como provedor sem contas. A UI traduz as chaves de erro do precheck antes de exibir o aviso.
## Failover por erro de acesso (etapa 10, ponto 2)

Tarefas headless podem repetir uma vez dentro do pool/TUI original após erro de autenticação, limite, modelo ou assinatura/saldo, somente com opt-in. A reserva por task, janela de 3 por pool/hora e cooldown de 30 minutos continuam valendo. O catálogo da conta de destino é usado; somente erro de modelo permite escolher outro modelo com acesso confirmado. O aviso pt-BR/en/es mostra conta, motivo e modelo. Terminais interativos não recebem failover. Detalhes em [POOL_FAILOVER.md](./POOL_FAILOVER.md).
# Taxa de sucesso das missões (Etapa 10)

Como o ADE AGS mede e protege a taxa de sucesso das missões.

## Ponto 4: Evitar missão duplicada

Quase todas as 9 missões canceladas no histórico do banco foram duplicatas iniciadas duas vezes por engano.
Para evitar que novas missões duplicadas sejam iniciadas acidentalmente:

### Regras de detecção
Uma missão é considerada duplicata se já existir outra com:
- O mesmo **título** (normalizado: minúsculas e espaços colapsados);
- O mesmo **objetivo** (normalizado: minúsculas e espaços colapsados);
- E essa outra missão estiver:
  - **Em andamento** (`running`); ou
  - **Recente** (criada ou iniciada nas últimas 24 horas, `RECENT_MISSION_SECS = 86400`).

### Comportamento
1. **No backend (`src-tauri/src/missions/duplicate.rs`, `src-tauri/src/missions/mod.rs`):**
   - Ao chamar `start_now` ou `start`, se houver duplicata e `force = false`, a operação é bloqueada com erro descritivo (`missions.error.duplicateRunning` ou `missions.error.duplicateRecent`).
   - Com `--force` na CLI (`ags mission start <id> --force`) ou `force: true`, o bloqueio pode ser contornado deliberadamente.
   - Fornece comandos Tauri `mission_check_duplicate` e `mission_check_duplicate_input`.
   - Testes unitários em `duplicate.rs` e integração em `src-tauri/src/missions/test.rs`.

2. **Na interface do usuário (`src/features/missions/`):**
   - **Ao clicar em Iniciar (`MissionsPage.tsx`, `MissionsSection.tsx`):** detecta a duplicata antes do disparo. Abre o diálogo de confirmação `DuplicateMissionDialog` com mensagem em pt-BR/en/es indicando a missão existente e seu status, permitindo ao usuário "Iniciar mesmo assim" (`force: true`) ou cancelar.
   - **No formulário de criação/edição (`MissionDialog.tsx`):** exibe um banner de aviso dinâmico caso o título e objetivo correspondam a uma missão em andamento ou recente.
   - **No detalhe da missão (`MissionsPage.tsx`):** exibe um banner de alerta se um rascunho duplicado for aberto.
   - Função pura `findDuplicateMission` em `duplicates.ts` testada em `tests/duplicates.test.ts`.
# Taxa de sucesso das missões (Etapa 10)

Como o QG do bot mede o sucesso. Este arquivo cobre o **ponto 6 (medir de forma honesta)**; os demais pontos da etapa (precheck, failover, classificação de falhas, duplicadas, entrega) acrescentam suas seções aqui.

## Fórmula

`successRate = done / (done + failed)`, arredondado, ou `null` ("--") sem missões fechadas. As **canceladas não entram na conta**: aparecem em um cartão próprio (`CANCELADAS`), porque muitas são duplicatas iniciadas duas vezes e não dizem nada sobre a qualidade do agente.

## Janelas

O cartão mostra três taxas lado a lado: **histórico**, **7 dias** e **30 dias**. Uma missão entra numa janela pela data em que fechou (`endedAt`, ou `startedAt` se não tiver fim). Missões sem início (rascunhos) ficam fora das janelas. Cada janela mostra também `ok · falhas · canceladas`.

## Missões de teste / E2E

Uma missão só sai da taxa se estiver **marcada explicitamente** (`isTest === true` em `Mission`). Ausente ou `null` = missão real. **Nunca se adivinha pelo título.** As marcadas aparecem em um cartão `TESTE/E2E` ("fora da taxa") e continuam contadas em `total`, `done`, `failed` etc.

A marcação está persistida em `missions.is_test` (schema v27) e exposta como `isTest` em mission_list/get e no status da CLI. Use `ags mission create|run ... --test` ou `ags mission start <id> --test`; a criação estruturada aceita `isTest: true` e os comandos de início aceitam `isTest` opcional. Ausência da marcação mantém a classificação existente no início/edição e cria missões reais por padrão. A migração mantém missões antigas como reais, sem alterar status ou inferir pelo título. Missões já encerradas não são reclassificadas pelo start.

## Código

- `src/features/bot/botStats.ts`: `botStats()` devolve `successRate` (histórico, sem testes), `testCount` e `windows.{d7,d30}`; `inWindow()` filtra por janela.
- `src/features/bot/BotPanel.tsx`: cartões da aba STATUS.
- Testes: `src/features/bot/tests/botStats.test.ts`.
- i18n: chaves `botPanel.card.success*`, `cancelled`, `tests*`, `windowSub` em pt-BR/en/es.

## Reavaliação e entrega segura de missões (Etapa 17, Ponto C)

Para missões que foram concluídas em terminais com `done_without_delivery` (por exemplo, quando o PR ainda estava aberto ou o CI ainda rodava no momento da conclusão), o ADE AGS oferece o comando seguro e idempotente:

```bash
ags mission redeliver <id> [--pr <N>] [--test passed|failed|not_run]
```

### Regras de segurança e promoção honesta
1. **Consulta no repositório correto (`origin`):** O comando resolve o repositório remoto a partir do `origin` do repositório da missão (`git remote get-url origin`) ou da URL completa do PR, passando explicitamente `--repo` ao GitHub CLI (`gh`). Isso evita falsos negativos causados pelo repositório padrão do usuário ou forks.
2. **Critérios estritos de promoção:** A missão só é promovida para `done` se:
   - Houver um PR identificado e verificado;
   - O estado do PR for comprovadamente mesclado (`MERGED`);
   - O rollup de status do CI estiver verde (`SUCCESS` ou `NEUTRAL`);
   - O resultado dos testes for `passed` (mantendo o existente ou atualizado explicitamente com `--test passed`).
3. **Nunca promove sem evidência:** Sem PR, sem testes aprovados, com PR aberto/fechado sem merge, ou com CI pendente/falho, a missão permanece em `done_without_delivery`.
4. **Proteção de estados imutáveis:** Nunca altera missões com status `failed` ou `cancelled` (nem rascunhos `draft`). Qualquer tentativa é rejeitada imediatamente com erro explicativo.
5. **Idempotência total:** Se a missão já estiver em `done`, o comando reavalia e confirma o estado sem re-promover (`promoted: false`), registrando a conferência de forma segura.
6. **Auditoria e rastreabilidade:** Todas as avaliações e reavaliações registram evidência na tabela `mission_delivery_audit` (com `previous_status`, `new_status`, `test_result`, `pull_request`, `pr_state`, `ci_status`, `promoted`, `reason` e `checked_at`) e atualizam a tabela `mission_terminal_deliveries`.
7. **Modo online e standalone:** Funciona via IPC quando o app ADE AGS está aberto e possui fallback standalone automático para executar diretamente contra `~/.ags/data.db` quando o app está fechado.

