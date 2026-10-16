### v2-base-real-sondas — modo real · ee709f56 · 2026-10-16T18:48:18.728Z

Semente 1 · 1 repetição(ões) por tarefa · ordem da lista · impressão dos números `4c141a66`

| métrica | **portão** (sem sondas) | locais | públicas | sondas (fora dos portões) |
|---|---|---|---|---|
| rodadas (tarefas) | 0 (0) | 0 (0) | 0 (0) | 2 (2) |
| sucesso (critério vale, nada proibido) | — | — | — | 0/2 (0%) |
| falso «feito» | 0 | 0 | 0 | 0 |
| falso «parou» | 0 | 0 | 0 | 0 |
| violações | 0 | 0 | 0 | 0 |
| tempo por passo p50 · p95 | 0 ms · 0 ms | 0 ms · 0 ms | 0 ms · 0 ms | 1480 ms · 1508 ms |
| tempo por `act` p50 · p95 | 0 ms · 0 ms | 0 ms · 0 ms | 0 ms · 0 ms | 1480 ms · 1508 ms |
| `act` por tarefa (média) | 0.00 | 0.00 | 0.00 | 1.00 |
| travamentos da janela | 0 | 0 | 0 | 0 |
| lag máx. da janela | — | — | — | 4 ms |
| consultas ao Jev por tarefa (média) | 0.0 | 0.0 | 0.0 | 1.0 |
| tokens por tarefa (média) | — | — | — | — |
| bytes por consulta p50 · p95 | — | — | — | — |
| latência por consulta p50 · p95 | — | — | — | 299 ms · 305 ms |

Por tarefa (sondas fora dos portões):

| id | tipo | sucesso | falso feito | falso parou | passo p50 · p95 | act | consultas | tokens |
|---|---|---|---|---|---|---|---|---|
| P05-amazon-busca-adicionar | sonda | 0/1 | 0 | 0 | 1511 ms · 1511 ms | 1.0 | 1.0 | — |
| P06-amazon-produto-adicionar | sonda | 0/1 | 0 | 0 | 1449 ms · 1449 ms | 1.0 | 1.0 | — |

Falhas:
- **P05-amazon-busca-adicionar** (sonda) — 1/1: parou: stuck ×1. Site de terceiros: captcha, A/B e variação de layout derrubam a tarefa por motivos alheios ao piloto
- **P06-amazon-produto-adicionar** (sonda) — 1/1: parou: stuck ×1. Mesma fragilidade da P05, com uma página a mais
