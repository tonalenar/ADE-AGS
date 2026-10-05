# Classificação de falhas de missão (Etapa 10, ponto 3 — UI)

Cada missão `failed` pode trazer `failureClass`: `access | limit | model | crash | timeout`. Ausente/desconhecido = `unknown` ("Falha sem classificação"), sem inventar causa; missões antigas não são reescritas.

| Classe | Rótulo (pt-BR) | Ação sugerida (pt-BR) |
|---|---|---|
| access | Falha de acesso | Logar de novo no agente ou trocar de conta |
| limit | Limite de uso esgotado | Esperar o limite renovar ou usar outra conta |
| model | Modelo indisponível | Escolher outro modelo disponível nesta conta |
| crash | O agente caiu | Tentar novamente; se repetir, ver o terminal |
| timeout | Tempo esgotado | Tentar novamente com um objetivo menor |

Textos em pt-BR/en/es: chaves `failure.<classe>.label|action`.

## Onde aparece
- **Detalhe da missão:** `FailureNotice` (rótulo, ação e `failureDetail` opcional) acima do aviso de "tentar novamente".
- **QG do bot:** na aba STATUS, um cartão por causa (`failuresByClass` em `botStats.ts`) com a ação; na aba MISSÕES, a causa e a ação da missão selecionada.

## Contrato com o backend
`Mission.failureClass?` e `Mission.failureDetail?` (`src/features/missions/types.ts`). **Pendente (backend/Classificador):** classificar o erro ao fechar a missão e expor esses campos; até lá tudo aparece como `unknown`.
