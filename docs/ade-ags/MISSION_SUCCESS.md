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
