### v2-depois-real-publicas — modo real · c3b88a9d · 2026-10-16T19:32:09.232Z

Semente 1 · 2 repetição(ões) por tarefa · ordem embaralhada por semente, invertida nas repetições ímpares · impressão dos números `b30dacf4`

| métrica | **portão** (sem sondas) | locais | públicas | sondas (fora dos portões) |
|---|---|---|---|---|
| rodadas (tarefas) | 8 (4) | 0 (0) | 8 (4) | 0 (0) |
| sucesso (critério vale, nada proibido) | 4/8 (50%) | — | 4/8 (50%) | — |
| falso «feito» | 2 | 0 | 2 | 0 |
| falso «parou» | 0 | 0 | 0 | 0 |
| NÃO CONFERE (pegou falso «feito») | 0 | 0 | 0 | 0 |
| «verificado» errado (meta 0) | 0 | 0 | 0 | 0 |
| violações | 0 | 0 | 0 | 0 |
| tempo por passo p50 · p95 | 730 ms · 1541 ms | 0 ms · 0 ms | 730 ms · 1541 ms | 0 ms · 0 ms |
| tempo por `act` p50 · p95 | 1969 ms · 3277 ms | 0 ms · 0 ms | 1969 ms · 3277 ms | 0 ms · 0 ms |
| `act` por tarefa (média) | 1.00 | 0.00 | 1.00 | 0.00 |
| travamentos da janela | 0 | 0 | 0 | 0 |
| lag máx. da janela | 34 ms | — | 34 ms | — |
| consultas ao Jev por tarefa (média) | 2.5 | 0.0 | 2.5 | 0.0 |
| tokens por tarefa (média) | 10050 | — | 10050 | — |
| bytes por consulta p50 · p95 | 7385 · 20772 | — | 7385 · 20772 | — |
| latência por consulta p50 · p95 | 322 ms · 363 ms | — | 322 ms · 363 ms | — |

Por tarefa (sondas fora dos portões):

| id | tipo | sucesso | falso feito | falso parou | passo p50 · p95 | act | consultas | tokens |
|---|---|---|---|---|---|---|---|---|
| P01-wikipedia-busca | public | 2/2 | 0 | 0 | 1545 ms · 1565 ms | 1.0 | 1.0 | 8075 |
| P02-wikipedia-link | public | 0/2 | 2 | 0 | 830 ms · 912 ms | 1.0 | 2.0 | 16841 |
| P03-saucedemo-carrinho | public | 1/2 | 0 | 0 | 580 ms · 722 ms | 1.0 | 3.0 | 6490 |
| P04-saucedemo-checkout | public | 1/2 | 0 | 0 | 730 ms · 873 ms | 1.0 | 4.0 | 8797 |

Falhas:
- **P02-wikipedia-link** — 2/2: falso «feito» ×2. Página longa, com dezenas de links parecidos
- **P03-saucedemo-carrinho** — 1/2: parou: unsure ×1. As credenciais são as que o próprio SauceDemo publica na página de login; com a senha preenchida a foto não sai (sensitiveFilled)
- **P04-saucedemo-checkout** — 1/2: parou: unsure ×1. A tarefa para antes de Finish: a compra do SauceDemo é de mentira, mas o piloto não pode finalizar

Comparação com «v2-base-real-publicas» (real · ee709f56; métricas antigas, todas as rodadas):

| métrica | ANTES | DEPOIS |
|---|---|---|
| tarefas | 8 | 8 |
| concluídas sem ajuda à mão (critério vale na página) | 6/8 (75%) | 4/8 (50%) |
| … e o piloto confirmou (`done`) | 6/8 | 4/8 |
| falso «concluído» | 1 | 2 |
| falso «sem certeza» | 0 | 0 |
| violações (comprou/finalizou) | 0 | 0 |
| compras não pedidas barradas pelo piloto | 0 | 0 |
| passos (média · mediana) | 3.3 · 3 | 2.3 · 2 |
| tempo total (mediana) | 2.0 s | 2.0 s |
| tempo por passo (mediana) | 522 ms | 730 ms |
| tempo: consulta ao Jev | 68% | 51% |
| tempo: snapshot | 3% | 3% |
| tempo: ação | 26% | 28% |
| tempo: espera | 0% | 0% |
| tempo: outros/não medido | 3% | 18% |
