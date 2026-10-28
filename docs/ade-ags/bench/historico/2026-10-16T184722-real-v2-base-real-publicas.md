### v2-base-real-publicas — modo real · ee709f56 · 2026-10-16T18:47:22.956Z

Semente 1 · 2 repetição(ões) por tarefa · ordem embaralhada por semente, invertida nas repetições ímpares · impressão dos números `841bee1a`

| métrica | **portão** (sem sondas) | locais | públicas | sondas (fora dos portões) |
|---|---|---|---|---|
| rodadas (tarefas) | 8 (4) | 0 (0) | 8 (4) | 0 (0) |
| sucesso (critério vale, nada proibido) | 6/8 (75%) | — | 6/8 (75%) | — |
| falso «feito» | 1 | 0 | 1 | 0 |
| falso «parou» | 0 | 0 | 0 | 0 |
| violações | 0 | 0 | 0 | 0 |
| tempo por passo p50 · p95 | 522 ms · 1171 ms | 0 ms · 0 ms | 522 ms · 1171 ms | 0 ms · 0 ms |
| tempo por `act` p50 · p95 | 2017 ms · 2678 ms | 0 ms · 0 ms | 2017 ms · 2678 ms | 0 ms · 0 ms |
| `act` por tarefa (média) | 1.00 | 0.00 | 1.00 | 0.00 |
| travamentos da janela | 0 | 0 | 0 | 0 |
| lag máx. da janela | 11 ms | — | 11 ms | — |
| consultas ao Jev por tarefa (média) | 3.3 | 0.0 | 3.3 | 0.0 |
| tokens por tarefa (média) | — | — | — | — |
| bytes por consulta p50 · p95 | — | — | — | — |
| latência por consulta p50 · p95 | 304 ms · 374 ms | — | 304 ms · 374 ms | — |

Por tarefa (sondas fora dos portões):

| id | tipo | sucesso | falso feito | falso parou | passo p50 · p95 | act | consultas | tokens |
|---|---|---|---|---|---|---|---|---|
| P01-wikipedia-busca | public | 2/2 | 0 | 0 | 735 ms · 1323 ms | 1.0 | 1.5 | — |
| P02-wikipedia-link | public | 0/2 | 1 | 0 | 1160 ms · 1160 ms | 1.0 | 2.0 | — |
| P03-saucedemo-carrinho | public | 2/2 | 0 | 0 | 379 ms · 625 ms | 1.0 | 4.0 | — |
| P04-saucedemo-checkout | public | 2/2 | 0 | 0 | 391 ms · 590 ms | 1.0 | 5.5 | — |

Falhas:
- **P02-wikipedia-link** — 2/2: parou: stuck ×1, falso «feito» ×1. Página longa, com dezenas de links parecidos
