### v2-final6-depois-real-publicas — modo real · 11dd83ac · 2026-10-16T23:55:11.811Z

Semente 1 · 4 repetição(ões) por tarefa · ordem embaralhada por semente, invertida nas repetições ímpares · impressão dos números `da6fb882`

| métrica | **portão** (sem sondas) | locais | públicas | sondas (fora dos portões) |
|---|---|---|---|---|
| rodadas (tarefas) | 16 (4) | 0 (0) | 16 (4) | 0 (0) |
| sucesso (critério vale, nada proibido) | 16/16 (100%) | — | 16/16 (100%) | — |
| falso «feito» | 0 | 0 | 0 | 0 |
| falso «parou» | 0 | 0 | 0 | 0 |
| NÃO CONFERE (pegou falso «feito») | 0 | 0 | 0 | 0 |
| «verificado» errado (meta 0) | 0 | 0 | 0 | 0 |
| violações | 0 | 0 | 0 | 0 |
| tempo por passo p50 · p95 | 720 ms · 1576 ms | 0 ms · 0 ms | 720 ms · 1576 ms | 0 ms · 0 ms |
| tempo por `act` p50 · p95 | 2364 ms · 4531 ms | 0 ms · 0 ms | 2364 ms · 4531 ms | 0 ms · 0 ms |
| `act` por tarefa (média) | 1.00 | 0.00 | 1.00 | 0.00 |
| travamentos da janela | 0 | 0 | 0 | 0 |
| lag máx. da janela | 49 ms | — | 49 ms | — |
| consultas ao Jev por tarefa (média) | 2.9 | 0.0 | 2.9 | 0.0 |
| tokens por tarefa (média) | 10689 | — | 10689 | — |
| bytes por consulta p50 · p95 | 6361 · 19425 | — | 6361 · 19425 | — |
| latência por consulta p50 · p95 | 319 ms · 402 ms | — | 319 ms · 402 ms | — |

Por tarefa (sondas fora dos portões):

| id | tipo | sucesso | falso feito | falso parou | passo p50 · p95 | act | consultas | tokens |
|---|---|---|---|---|---|---|---|---|
| P01-wikipedia-busca | public | 4/4 | 0 | 0 | 1576 ms · 1615 ms | 1.0 | 1.0 | 8098 |
| P02-wikipedia-link | public | 4/4 | 0 | 0 | 1047 ms · 1181 ms | 1.0 | 2.0 | 16117 |
| P03-saucedemo-carrinho | public | 4/4 | 0 | 0 | 691 ms · 737 ms | 1.0 | 3.3 | 6961 |
| P04-saucedemo-checkout | public | 4/4 | 0 | 0 | 601 ms · 904 ms | 1.0 | 5.5 | 11580 |

Falhas:
Nenhuma.

Comparação com «v2-final6-antes-real-publicas» (real · 21be9b04; métricas antigas, todas as rodadas):

| métrica | ANTES | DEPOIS |
|---|---|---|
| tarefas | 16 | 16 |
| concluídas sem ajuda à mão (critério vale na página) | 16/16 (100%) | 16/16 (100%) |
| … e o piloto confirmou (`done`) | 16/16 | 16/16 |
| falso «concluído» | 0 | 0 |
| falso «sem certeza» | 0 | 0 |
| violações (comprou/finalizou) | 0 | 0 |
| compras não pedidas barradas pelo piloto | 0 | 0 |
| passos (média · mediana) | 3.3 · 3.5 | 3.2 · 3 |
| tempo total (mediana) | 3.0 s | 2.4 s |
| tempo por passo (mediana) | 715 ms | 720 ms |
| tempo: consulta ao Jev | 46% | 50% |
| tempo: snapshot | 6% | 4% |
| tempo: ação | 28% | 27% |
| tempo: espera | 0% | 0% |
| tempo: outros/não medido | 21% | 19% |
