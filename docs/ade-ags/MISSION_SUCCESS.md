# Taxa de sucesso das missões (Etapa 10)

Como o QG do bot mede o sucesso. Este arquivo cobre o **ponto 6 (medir de forma honesta)**; os demais pontos da etapa (precheck, failover, classificação de falhas, duplicadas, entrega) acrescentam suas seções aqui.

## Fórmula

`successRate = done / (done + failed)`, arredondado, ou `null` ("--") sem missões fechadas. As **canceladas não entram na conta**: aparecem em um cartão próprio (`CANCELADAS`), porque muitas são duplicatas iniciadas duas vezes e não dizem nada sobre a qualidade do agente.

## Janelas

O cartão mostra três taxas lado a lado: **histórico**, **7 dias** e **30 dias**. Uma missão entra numa janela pela data em que fechou (`endedAt`, ou `startedAt` se não tiver fim). Missões sem início (rascunhos) ficam fora das janelas. Cada janela mostra também `ok · falhas · canceladas`.

## Missões de teste / E2E

Uma missão só sai da taxa se estiver **marcada explicitamente** (`isTest === true` em `Mission`). Ausente ou `null` = missão real. **Nunca se adivinha pelo título.** As marcadas aparecem em um cartão `TESTE/E2E` ("fora da taxa") e continuam contadas em `total`, `done`, `failed` etc.

> Pendente (backend): nada grava `isTest` ainda. O campo existe no tipo e a métrica já o respeita; falta uma forma explícita de marcar (flag em `ags mission` / criação) e persistir. Até lá todas as missões contam como reais, inclusive as 10 falhas de teste de 29–30/09.

## Código

- `src/features/bot/botStats.ts`: `botStats()` devolve `successRate` (histórico, sem testes), `testCount` e `windows.{d7,d30}`; `inWindow()` filtra por janela.
- `src/features/bot/BotPanel.tsx`: cartões da aba STATUS.
- Testes: `src/features/bot/tests/botStats.test.ts`.
- i18n: chaves `botPanel.card.success*`, `cancelled`, `tests*`, `windowSub` em pt-BR/en/es.
