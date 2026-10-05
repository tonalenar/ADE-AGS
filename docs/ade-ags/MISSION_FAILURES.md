# Classificação de falhas de missão (Etapa 10, ponto 3)

Uma missão que termina como `failed` pode expor `failureClassification`, com `category` (`access`, `limit`, `model`, `crash` ou `timeout`) e `actionKey` (chave i18n `missions.failure.action.*`). `failureDetail` guarda o erro da tarefa Lead que falhou ou, na ausência dele, da tarefa com falha mais recente, limitado a 600 caracteres. Uma falha sem correspondência fica sem classificação; não inventamos a causa.

## Heurísticas

O classificador reutiliza `runs::failure::classify`: erros de quota permanecem `limit` e credenciais rejeitadas permanecem `access`, com a mesma prioridade usada pelo failover. Também reconhece erros de acesso HTTP 403 e indisponibilidade 503, erros de modelo inexistente ou inválido, falhas de inicialização/crash e timeout (inclusive HTTP 504).

| Categoria | Ação sugerida |
|---|---|
| access | missions.failure.action.loginAgain, checkPlanOrBalance, checkPlanAccess ou checkServiceStatus |
| limit | missions.failure.action.waitForQuotaReset |
| model | missions.failure.action.chooseAvailableModel |
| crash | missions.failure.action.restartAgent |
| timeout | missions.failure.action.retryAfterTimeout |

Os textos das ações ficam nas traduções pt-BR/en/es do Frontend.

## API e persistência

`mission_list` devolve os campos em cada `MissionSummary` (herdados de `Mission`). `mission_get` os devolve em `MissionDetail.mission`. A CLI `ags mission status|wait|run` também inclui os campos no resumo.

A classificação e o detalhe são gravados ao fechar a missão como falha, junto do run ativo. Ao iniciar um retry, os campos da tentativa anterior são limpos; os erros anteriores continuam nos runs/tasks históricos. Missões antigas não recebem classificação retroativa. O detalhe original é limitado a 600 caracteres.

## Onde aparece

- Detalhe da missão: `FailureNotice` mostra rótulo, ação e o detalhe opcional.
- QG do bot: um cartão por causa na aba STATUS e a causa/ação da missão selecionada na aba MISSÕES.
