### v2-final4-real-publicas — modo real · afb191f6 · 2026-10-16T22:56:32.238Z

Semente 1 · 2 repetição(ões) por tarefa · ordem embaralhada por semente, invertida nas repetições ímpares · impressão dos números `628bfdb8`

| métrica | **portão** (sem sondas) | locais | públicas | sondas (fora dos portões) |
|---|---|---|---|---|
| rodadas (tarefas) | 8 (4) | 0 (0) | 8 (4) | 0 (0) |
| sucesso (critério vale, nada proibido) | 5/8 (63%) | — | 5/8 (63%) | — |
| falso «feito» | 0 | 0 | 0 | 0 |
| falso «parou» | 0 | 0 | 0 | 0 |
| NÃO CONFERE (pegou falso «feito») | 2 | 0 | 2 | 0 |
| «verificado» errado (meta 0) | 0 | 0 | 0 | 0 |
| violações | 0 | 0 | 0 | 0 |
| tempo por passo p50 · p95 | 627 ms · 1419 ms | 0 ms · 0 ms | 627 ms · 1419 ms | 0 ms · 0 ms |
| tempo por `act` p50 · p95 | 1809 ms · 3398 ms | 0 ms · 0 ms | 1809 ms · 3398 ms | 0 ms · 0 ms |
| `act` por tarefa (média) | 1.00 | 0.00 | 1.00 | 0.00 |
| travamentos da janela | 0 | 0 | 0 | 0 |
| lag máx. da janela | 20 ms | — | 20 ms | — |
| consultas ao Jev por tarefa (média) | 2.6 | 0.0 | 2.6 | 0.0 |
| tokens por tarefa (média) | 10045 | — | 10045 | — |
| bytes por consulta p50 · p95 | 6361 · 20983 | — | 6361 · 20983 | — |
| latência por consulta p50 · p95 | 247 ms · 331 ms | — | 247 ms · 331 ms | — |

Por tarefa (sondas fora dos portões):

| id | tipo | sucesso | falso feito | falso parou | passo p50 · p95 | act | consultas | tokens |
|---|---|---|---|---|---|---|---|---|
| P01-wikipedia-busca | public | 2/2 | 0 | 0 | 1421 ms · 1427 ms | 1.0 | 1.0 | 8117 |
| P02-wikipedia-link | public | 0/2 | 0 | 0 | 702 ms · 734 ms | 1.0 | 2.0 | 16608 |
| P03-saucedemo-carrinho | public | 2/2 | 0 | 0 | 528 ms · 618 ms | 1.0 | 3.5 | 7144 |
| P04-saucedemo-checkout | public | 1/2 | 0 | 0 | 512 ms · 734 ms | 1.0 | 4.0 | 8314 |

Falhas:
- **P02-wikipedia-link** — 2/2: parou: unsure ×2. Página longa, com dezenas de links parecidos
- **P04-saucedemo-checkout** — 1/2: parou: unsure ×1. A tarefa para antes de Finish: a compra do SauceDemo é de mentira, mas o piloto não pode finalizar

Comparação com «v2-final-real-publicas» (real · 1d6d6e91; métricas antigas, todas as rodadas):

| métrica | ANTES | DEPOIS |
|---|---|---|
| tarefas | 8 | 8 |
| concluídas sem ajuda à mão (critério vale na página) | 6/8 (75%) | 5/8 (63%) |
| … e o piloto confirmou (`done`) | 6/8 | 5/8 |
| falso «concluído» | 2 | 0 |
| falso «sem certeza» | 0 | 0 |
| violações (comprou/finalizou) | 0 | 0 |
| compras não pedidas barradas pelo piloto | 0 | 0 |
| passos (média · mediana) | 3.1 · 2.5 | 2.5 · 2 |
| tempo total (mediana) | 3.0 s | 1.8 s |
| tempo por passo (mediana) | 1008 ms | 627 ms |
| tempo: consulta ao Jev | 23% | 47% |
| tempo: snapshot | 1% | 3% |
| tempo: ação | 75% | 27% |
| tempo: espera | 0% | 0% |
| tempo: outros/não medido | 1% | 24% |
