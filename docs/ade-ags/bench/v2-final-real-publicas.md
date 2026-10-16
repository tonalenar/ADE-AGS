### v2-final-real-publicas — modo real · 1d6d6e91 · 2026-10-16T20:54:16.663Z

Semente 1 · 2 repetição(ões) por tarefa · ordem embaralhada por semente, invertida nas repetições ímpares · impressão dos números `76c12c89`

| métrica | **portão** (sem sondas) | locais | públicas | sondas (fora dos portões) |
|---|---|---|---|---|
| rodadas (tarefas) | 8 (4) | 0 (0) | 8 (4) | 0 (0) |
| sucesso (critério vale, nada proibido) | 6/8 (75%) | — | 6/8 (75%) | — |
| falso «feito» | 2 | 0 | 2 | 0 |
| falso «parou» | 0 | 0 | 0 | 0 |
| NÃO CONFERE (pegou falso «feito») | 0 | 0 | 0 | 0 |
| «verificado» errado (meta 0) | 0 | 0 | 0 | 0 |
| violações | 0 | 0 | 0 | 0 |
| tempo por passo p50 · p95 | 1008 ms · 3992 ms | 0 ms · 0 ms | 1008 ms · 3992 ms | 0 ms · 0 ms |
| tempo por `act` p50 · p95 | 3044 ms · 9591 ms | 0 ms · 0 ms | 3044 ms · 9591 ms | 0 ms · 0 ms |
| `act` por tarefa (média) | 1.00 | 0.00 | 1.00 | 0.00 |
| travamentos da janela | 0 | 0 | 0 | 0 |
| lag máx. da janela | — | — | — | — |
| consultas ao Jev por tarefa (média) | 3.1 | 0.0 | 3.1 | 0.0 |
| tokens por tarefa (média) | — | — | — | — |
| bytes por consulta p50 · p95 | — | — | — | — |
| latência por consulta p50 · p95 | 312 ms · 369 ms | — | 312 ms · 369 ms | — |

Por tarefa (sondas fora dos portões):

| id | tipo | sucesso | falso feito | falso parou | passo p50 · p95 | act | consultas | tokens |
|---|---|---|---|---|---|---|---|---|
| P01-wikipedia-busca | public | 2/2 | 0 | 0 | 1999 ms · 2418 ms | 1.0 | 1.0 | — |
| P02-wikipedia-link | public | 0/2 | 2 | 0 | 1532 ms · 2037 ms | 1.0 | 2.0 | — |
| P03-saucedemo-carrinho | public | 2/2 | 0 | 0 | 1006 ms · 2363 ms | 1.0 | 3.5 | — |
| P04-saucedemo-checkout | public | 2/2 | 0 | 0 | 1008 ms · 3995 ms | 1.0 | 6.0 | — |

Falhas:
- **P02-wikipedia-link** — 2/2: falso «feito» ×2. Página longa, com dezenas de links parecidos

Comparação com «v2-base-real-publicas» (real · ee709f56; métricas antigas, todas as rodadas):

| métrica | ANTES | DEPOIS |
|---|---|---|
| tarefas | 8 | 8 |
| concluídas sem ajuda à mão (critério vale na página) | 6/8 (75%) | 6/8 (75%) |
| … e o piloto confirmou (`done`) | 6/8 | 6/8 |
| falso «concluído» | 1 | 2 |
| falso «sem certeza» | 0 | 0 |
| violações (comprou/finalizou) | 0 | 0 |
| compras não pedidas barradas pelo piloto | 0 | 0 |
| passos (média · mediana) | 3.3 · 3 | 3.1 · 2.5 |
| tempo total (mediana) | 2.0 s | 3.0 s |
| tempo por passo (mediana) | 522 ms | 1008 ms |
| tempo: consulta ao Jev | 68% | 23% |
| tempo: snapshot | 3% | 1% |
| tempo: ação | 26% | 75% |
| tempo: espera | 0% | 0% |
| tempo: outros/não medido | 3% | 1% |
