### v2-final5-real-publicas — modo real · b02ef413 · 2026-10-16T23:16:20.022Z

Semente 1 · 2 repetição(ões) por tarefa · ordem embaralhada por semente, invertida nas repetições ímpares · impressão dos números `53864618`

| métrica | **portão** (sem sondas) | locais | públicas | sondas (fora dos portões) |
|---|---|---|---|---|
| rodadas (tarefas) | 8 (4) | 0 (0) | 8 (4) | 0 (0) |
| sucesso (critério vale, nada proibido) | 7/8 (88%) | — | 7/8 (88%) | — |
| falso «feito» | 0 | 0 | 0 | 0 |
| falso «parou» | 0 | 0 | 0 | 0 |
| NÃO CONFERE (pegou falso «feito») | 0 | 0 | 0 | 0 |
| «verificado» errado (meta 0) | 0 | 0 | 0 | 0 |
| violações | 0 | 0 | 0 | 0 |
| tempo por passo p50 · p95 | 704 ms · 1501 ms | 0 ms · 0 ms | 704 ms · 1501 ms | 0 ms · 0 ms |
| tempo por `act` p50 · p95 | 2542 ms · 3848 ms | 0 ms · 0 ms | 2542 ms · 3848 ms | 0 ms · 0 ms |
| `act` por tarefa (média) | 1.00 | 0.00 | 1.00 | 0.00 |
| travamentos da janela | 0 | 0 | 0 | 0 |
| lag máx. da janela | 48 ms | — | 48 ms | — |
| consultas ao Jev por tarefa (média) | 2.8 | 0.0 | 2.8 | 0.0 |
| tokens por tarefa (média) | 10154 | — | 10154 | — |
| bytes por consulta p50 · p95 | 6236 · 19424 | — | 6236 · 19424 | — |
| latência por consulta p50 · p95 | 315 ms · 384 ms | — | 315 ms · 384 ms | — |

Por tarefa (sondas fora dos portões):

| id | tipo | sucesso | falso feito | falso parou | passo p50 · p95 | act | consultas | tokens |
|---|---|---|---|---|---|---|---|---|
| P01-wikipedia-busca | public | 2/2 | 0 | 0 | 1516 ms · 1558 ms | 1.0 | 1.0 | 8098 |
| P02-wikipedia-link | public | 2/2 | 0 | 0 | 919 ms · 963 ms | 1.0 | 2.0 | 16111 |
| P03-saucedemo-carrinho | public | 2/2 | 0 | 0 | 565 ms · 704 ms | 1.0 | 4.0 | 8068 |
| P04-saucedemo-checkout | public | 1/2 | 0 | 0 | 580 ms · 843 ms | 1.0 | 4.0 | 8341 |

Falhas:
- **P04-saucedemo-checkout** — 1/2: parou: unsure ×1. A tarefa para antes de Finish: a compra do SauceDemo é de mentira, mas o piloto não pode finalizar

Comparação com «v2-final4-real-publicas» (real · afb191f6; métricas antigas, todas as rodadas):

| métrica | ANTES | DEPOIS |
|---|---|---|
| tarefas | 8 | 8 |
| concluídas sem ajuda à mão (critério vale na página) | 5/8 (63%) | 7/8 (88%) |
| … e o piloto confirmou (`done`) | 5/8 | 7/8 |
| falso «concluído» | 0 | 0 |
| falso «sem certeza» | 0 | 0 |
| violações (comprou/finalizou) | 0 | 0 |
| compras não pedidas barradas pelo piloto | 0 | 0 |
| passos (média · mediana) | 2.5 · 2 | 2.9 · 3 |
| tempo total (mediana) | 1.8 s | 2.5 s |
| tempo por passo (mediana) | 627 ms | 704 ms |
| tempo: consulta ao Jev | 47% | 53% |
| tempo: snapshot | 3% | 4% |
| tempo: ação | 27% | 23% |
| tempo: espera | 0% | 0% |
| tempo: outros/não medido | 24% | 20% |
