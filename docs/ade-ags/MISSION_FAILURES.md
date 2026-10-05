# Classificação de falhas de missão (Etapa 10, ponto 3 — UI)

Contrato final com o backend (Classificador): `Mission.failureClassification: null | { category, actionKey }`, com `category` em `access | limit | model | crash | timeout` e `actionKey` uma chave i18n. Ausente/`null`/categoria desconhecida em missão `failed` = `unknown` ("Falha sem classificação"), sem inventar causa; missões antigas não são reescritas.

## Chaves i18n (pt-BR/en/es)
- Rótulo por categoria: `missions.failure.label.<access|limit|model|crash|timeout|unknown>`.
- Ação: `missions.failure.action.<loginAgain|checkPlanOrBalance|waitForQuotaReset|checkPlanAccess|checkServiceStatus|chooseAvailableModel|restartAgent|retryAfterTimeout|unknown>`. Se o `actionKey` não for dessa família, usa `unknown`.

## Onde aparece
- **Detalhe da missão:** `FailureNotice` (rótulo + ação) acima do aviso de "tentar novamente".
- **QG do bot:** na aba STATUS, um cartão por causa (`failuresByClass` em `botStats.ts`); na aba MISSÕES, a causa e a ação da missão selecionada.

## Pendente
Backend gravar/expor `failureClassification` ao fechar a missão (Classificador). Até lá tudo aparece como `unknown`.
