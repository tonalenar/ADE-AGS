# Etapa 20 — ponto 5: resumo de revisão por workspace

O comando aditivo `memory_review_summary_workspace({ workspaceId })` retorna um
objeto `{ workspaceId, groups, counts }`. Grupos contêm
`{ missionId, missionTitle, title, items, counts }`, somente quando há pendentes.
Cada item tem o formato de `memory_review_summary` acrescido de `operation`:
identificador e revisão, chave, tipo, corpo, prioridade, evidência, referência de
duplicata/contradição, score e marca de alto valor. Grupos são ordenados pelo título
e id; itens preservam a ordenação do resumo existente. Propostas sem missão ficam
no último grupo com `missionId=null`, `missionTitle=null` e `title=""`, para o
frontend rotular no idioma da interface. Operações `delete` aparecem explicitamente
como exclusões, sem classificação automática como sugestão de alto valor.

Uma única chamada e um único lock da conexão agregam todas as missões do workspace,
incluindo propostas de escopo workspace cuja origem é um run da missão. Outros
workspaces e propostas já decididas são excluídos. Workspace inexistente retorna
erro; workspace conhecido sem propostas retorna grupos vazios e contagens zero.
As contagens totais incluem exclusões e sugestões sem run, como `memory_pending_counts`.

O comando somente lê. Aprovar ou rejeitar, inclusive em massa, continua dependendo
da decisão explícita do usuário via `memory_decide_user` por item. Não há migração,
mudança de schema nem alteração dos comandos existentes.

## Classificação e aprovação

O resumo por missão existente continua com seu contrato original. A API de workspace
complementa a consulta para incluir também exclusões e sugestões sem run.
As marcas de contradição/duplicata
do resumo comparam com memórias já aprovadas; detectar conflitos entre propostas
pendentes e pedir confirmação em massa continua sendo responsabilidade da revisão
no frontend. Nenhuma contradição é aprovada pelo comando de resumo.

## Testes

`cargo test --lib memory::review::` cobre grupos/títulos, missões vazias,
workspace inexistente, isolamento entre workspaces, decisões já concluídas,
preservação das classificações/evidências de runs, grupo sem missão, exclusões em
missões e workspace, igualdade com `memory_pending_counts` e ausência de aprovação automática.
