# Etapa 11 — eficiência entre agentes, ponto 4

O ponto 4 mede se dividir uma missão ajuda. O cartão aparece no QG e no painel de tempos da missão; os dados também estão disponíveis por IPC (`mission_efficiency`) e CLI (`ags mission efficiency <id>`).

## Métricas por missão

- **Tempo ativo (`activeMs`)**: união dos intervalos dos spans `turn` e `peer_ask`. Intervalos sobrepostos contam uma vez. Sem spans aplicáveis, o valor fica não medido (`null`).
- **Relógio (`wallMs`)**: diferença entre `started_at` e `ended_at`; enquanto a missão está em andamento, usa o horário atual.
- **Custo estimado (`costEstimate`)**: soma de `spent_usd` dos Runs da missão, incluindo tentativas anteriores. Fica `null` quando nenhum Task reportou custo. A UI não apresenta custo ausente como zero.
- **Agentes (`agents`)**: quantidade de nomes distintos observados nos spans; o destino de um `peer_ask` também conta como participante.

## Comparação histórica

Para cada missão, a ADE considera até as 30 missões mais recentes concluídas no mesmo workspace, exclui missões de teste e agrupa as amostras por 1, 2, 3–4 ou 5+ agentes. A tabela mostra medianas de tempo ativo, relógio e custo, além do ganho percentual de cada faixa contra a mediana histórica de um agente. Também compara a missão atual com essa referência de um agente.

Os ganhos são observações do histórico do workspace, não uma prova causal: missões diferentes podem ter objetivos e dificuldades diferentes. A quantidade de amostras fica visível. Se o histórico não tiver uma faixa de um agente ou se o provider não reportar custo, o ganho correspondente aparece como não medido.

O briefing do orquestrador orienta recrutar somente quando o trabalho for independente e paralelizável e houver expectativa de terminar mais rápido do que com um agente só. O custo de coordenação e recursos também importa.

## Limites dos dados

O tempo ativo depende da cobertura dos spans registrados. Agentes sem spans não entram na contagem observada. Providers que não reportam custo deixam `costEstimate` e o ganho de custo sem medição; não se infere custo zero. Para a fotografia anterior às mudanças da Etapa 11, consulte [AGENT_EFFICIENCY_BASELINE.md](./AGENT_EFFICIENCY_BASELINE.md), preparado pelo QA.
