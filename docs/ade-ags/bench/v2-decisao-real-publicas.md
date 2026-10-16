### dec-r1p — modo real · f02dfe99 · 2026-10-16T20:22:50.240Z

Semente 1 · 2 repetição(ões) por tarefa · ordem embaralhada por semente, invertida nas repetições ímpares · impressão dos números `ed7c3adb`

| métrica | **portão** (sem sondas) | locais | públicas | sondas (fora dos portões) |
|---|---|---|---|---|
| rodadas (tarefas) | 6 (3) | 0 (0) | 6 (3) | 0 (0) |
| sucesso (critério vale, nada proibido) | 3/6 (50%) | — | 3/6 (50%) | — |
| falso «feito» | 2 | 0 | 2 | 0 |
| falso «parou» | 0 | 0 | 0 | 0 |
| NÃO CONFERE (pegou falso «feito») | 0 | 0 | 0 | 0 |
| «verificado» errado (meta 0) | 0 | 0 | 0 | 0 |
| violações | 0 | 0 | 0 | 0 |
| tempo por passo p50 · p95 | 682 ms · 931 ms | 0 ms · 0 ms | 682 ms · 931 ms | 0 ms · 0 ms |
| tempo por `act` p50 · p95 | 2545 ms · 4366 ms | 0 ms · 0 ms | 2545 ms · 4366 ms | 0 ms · 0 ms |
| `act` por tarefa (média) | 1.00 | 0.00 | 1.00 | 0.00 |
| travamentos da janela | 0 | 0 | 0 | 0 |
| lag máx. da janela | 24 ms | — | 24 ms | — |
| consultas ao Jev por tarefa (média) | 3.7 | 0.0 | 3.7 | 0.0 |
| tokens por tarefa (média) | 11542 | — | 11542 | — |
| bytes por consulta p50 · p95 | 5749 · 20528 | — | 5749 · 20528 | — |
| latência por consulta p50 · p95 | 302 ms · 335 ms | — | 302 ms · 335 ms | — |

Por tarefa (sondas fora dos portões):

| id | tipo | sucesso | falso feito | falso parou | passo p50 · p95 | act | consultas | tokens |
|---|---|---|---|---|---|---|---|---|
| P02-wikipedia-link | public | 0/2 | 2 | 0 | 876 ms · 982 ms | 1.0 | 2.0 | 16469 |
| P03-saucedemo-carrinho | public | 1/2 | 0 | 0 | 483 ms · 728 ms | 1.0 | 3.5 | 7392 |
| P04-saucedemo-checkout | public | 2/2 | 0 | 0 | 569 ms · 875 ms | 1.0 | 5.5 | 10766 |

Falhas:
- **P02-wikipedia-link** — 2/2: falso «feito» ×2. Página longa, com dezenas de links parecidos
- **P03-saucedemo-carrinho** — 1/2: parou: unsure ×1. As credenciais são as que o próprio SauceDemo publica na página de login; com a senha preenchida a foto não sai (sensitiveFilled)
