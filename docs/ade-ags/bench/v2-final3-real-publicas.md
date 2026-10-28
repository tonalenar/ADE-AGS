### v2-final3-real-publicas — modo real · f4ecf88d · 2026-10-16T22:48:48.059Z

Semente 1 · 2 repetição(ões) por tarefa · ordem embaralhada por semente, invertida nas repetições ímpares · impressão dos números `7cacd687`

| métrica | **portão** (sem sondas) | locais | públicas | sondas (fora dos portões) |
|---|---|---|---|---|
| rodadas (tarefas) | 8 (4) | 0 (0) | 8 (4) | 0 (0) |
| sucesso (critério vale, nada proibido) | 4/8 (50%) | — | 4/8 (50%) | — |
| falso «feito» | 0 | 0 | 0 | 0 |
| falso «parou» | 0 | 0 | 0 | 0 |
| NÃO CONFERE (pegou falso «feito») | 1 | 0 | 1 | 0 |
| «verificado» errado (meta 0) | 0 | 0 | 0 | 0 |
| violações | 0 | 0 | 0 | 0 |
| tempo por passo p50 · p95 | 695 ms · 1780 ms | 0 ms · 0 ms | 695 ms · 1780 ms | 0 ms · 0 ms |
| tempo por `act` p50 · p95 | 2748 ms · 3715 ms | 0 ms · 0 ms | 2748 ms · 3715 ms | 0 ms · 0 ms |
| `act` por tarefa (média) | 1.00 | 0.00 | 1.00 | 0.00 |
| travamentos da janela | 0 | 0 | 0 | 0 |
| lag máx. da janela | 7 ms | — | 7 ms | — |
| consultas ao Jev por tarefa (média) | 2.9 | 0.0 | 2.9 | 0.0 |
| tokens por tarefa (média) | 9590 | — | 9590 | — |
| bytes por consulta p50 · p95 | 5965 · 19014 | — | 5965 · 19014 | — |
| latência por consulta p50 · p95 | 310 ms · 371 ms | — | 310 ms · 371 ms | — |

Por tarefa (sondas fora dos portões):

| id | tipo | sucesso | falso feito | falso parou | passo p50 · p95 | act | consultas | tokens |
|---|---|---|---|---|---|---|---|---|
| P01-wikipedia-busca | public | 2/2 | 0 | 0 | 1567 ms · 1679 ms | 1.0 | 1.0 | 7971 |
| P02-wikipedia-link | public | 0/2 | 0 | 0 | 1615 ms · 2217 ms | 1.0 | 1.5 | 12088 |
| P03-saucedemo-carrinho | public | 0/2 | 0 | 0 | 594 ms · 761 ms | 1.0 | 3.0 | 6128 |
| P04-saucedemo-checkout | public | 2/2 | 0 | 0 | 471 ms · 865 ms | 1.0 | 6.0 | 12175 |

Falhas:
- **P02-wikipedia-link** — 2/2: parou: stuck ×1, parou: unsure ×1. Página longa, com dezenas de links parecidos
- **P03-saucedemo-carrinho** — 2/2: parou: unsure ×2. As credenciais são as que o próprio SauceDemo publica na página de login; com a senha preenchida a foto não sai (sensitiveFilled)

Comparação com «v2-final-real-publicas» (real · 1d6d6e91; métricas antigas, todas as rodadas):

| métrica | ANTES | DEPOIS |
|---|---|---|
| tarefas | 8 | 8 |
| concluídas sem ajuda à mão (critério vale na página) | 6/8 (75%) | 4/8 (50%) |
| … e o piloto confirmou (`done`) | 6/8 | 4/8 |
| falso «concluído» | 2 | 0 |
| falso «sem certeza» | 0 | 0 |
| violações (comprou/finalizou) | 0 | 0 |
| compras não pedidas barradas pelo piloto | 0 | 0 |
| passos (média · mediana) | 3.1 · 2.5 | 2.6 · 2 |
| tempo total (mediana) | 3.0 s | 2.7 s |
| tempo por passo (mediana) | 1008 ms | 695 ms |
| tempo: consulta ao Jev | 23% | 52% |
| tempo: snapshot | 1% | 2% |
| tempo: ação | 75% | 26% |
| tempo: espera | 0% | 0% |
| tempo: outros/não medido | 1% | 20% |
