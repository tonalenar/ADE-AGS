### original-real-j2 — modo real · 5ef9153f · 2026-10-17T17:49:56.213Z

Semente 1 · 1 repetição(ões) por tarefa · ordem da lista · impressão dos números `6ec15f90`

| métrica | **portão** (sem sondas) | locais | públicas | sondas (fora dos portões) |
|---|---|---|---|---|
| rodadas (tarefas) | 31 (31) | 27 (27) | 4 (4) | 2 (2) |
| sucesso (critério vale, nada proibido) | 31/31 (100%) | 27/27 (100%) | 4/4 (100%) | 0/2 (0%) |
| sucesso IC 95% (Wilson) | 89.0% – 100.0% | 87.5% – 100.0% | 51.0% – 100.0% | 0.0% – 65.8% |
| SPRT: meta ≥ 98% (contra ≤ 95%) | rodar mais | rodar mais | rodar mais | rodar mais |
| erro silencioso (falso «feito» + violações), teto IC 95% | 0/31 · até 11.0% | 0/27 · até 12.5% | 0/4 · até 49.0% | 0/2 · até 65.8% |
| falso «feito» | 0 | 0 | 0 | 0 |
| falso «parou» | 0 | 0 | 0 | 0 |
| NÃO CONFERE (pegou falso «feito») | 0 | 0 | 0 | 0 |
| «verificado» errado (meta 0) | 0 | 0 | 0 | 0 |
| violações | 0 | 0 | 0 | 0 |
| tempo por passo p50 · p95 | 531 ms · 1619 ms | 531 ms · 2034 ms | 590 ms · 953 ms | 1382 ms · 1452 ms |
| tempo por `act` p50 · p95 | 1122 ms · 6587 ms | 1018 ms · 6652 ms | 2366 ms · 4318 ms | 1382 ms · 1452 ms |
| `act` por tarefa (média) | 1.03 | 1.04 | 1.00 | 1.00 |
| travamentos da janela | 0 | 0 | 0 | 0 |
| lag máx. da janela | 21 ms | 21 ms | 9 ms | 7 ms |
| consultas ao Jev por tarefa (média) | 1.5 | 1.4 | 2.3 | 1.0 |
| tokens por tarefa (média) | 2574 | 1924 | 6960 | 1033 |
| bytes por consulta p50 · p95 | 4337 · 9846 | 4184 · 5073 | 9722 · 15356 | 3243 · 3255 |
| latência por consulta p50 · p95 | 304 ms · 342 ms | 304 ms · 347 ms | 306 ms · 334 ms | 302 ms · 309 ms |

Por tarefa (sondas fora dos portões):

| id | tipo | sucesso | falso feito | falso parou | passo p50 · p95 | act | consultas | tokens |
|---|---|---|---|---|---|---|---|---|
| L01-icones-sem-nome | local | 1/1 | 0 | 0 | 746 ms · 746 ms | 1.0 | 1.0 | 1304 |
| L02-lupa-entre-iguais | local | 1/1 | 0 | 0 | 751 ms · 751 ms | 1.0 | 1.0 | 1325 |
| L03-busca-com-enter | local | 1/1 | 0 | 0 | 843 ms · 843 ms | 1.0 | 0.0 | 0 |
| L04-busca-com-botao | local | 1/1 | 0 | 0 | 848 ms · 848 ms | 1.0 | 0.0 | 0 |
| L05-cookies | local | 1/1 | 0 | 0 | 430 ms · 430 ms | 1.0 | 2.0 | 2660 |
| L06-modal-newsletter | local | 1/1 | 0 | 0 | 448 ms · 448 ms | 1.0 | 2.0 | 2651 |
| L07-garantia-upsell | local | 1/1 | 0 | 0 | 447 ms · 455 ms | 1.0 | 2.0 | 2843 |
| L08-produto-sem-botao | local | 1/1 | 0 | 0 | 609 ms · 771 ms | 1.0 | 2.0 | 2943 |
| L09-botoes-repetidos | local | 1/1 | 0 | 0 | 427 ms · 427 ms | 1.0 | 1.0 | 1899 |
| L10-lista-e-radio | local | 1/1 | 0 | 0 | 520 ms · 582 ms | 1.0 | 2.0 | 3675 |
| L11-formulario-multietapas | local | 1/1 | 0 | 0 | 701 ms · 704 ms | 1.0 | 3.0 | 4501 |
| L12-garantia-na-foto | local | 1/1 | 0 | 0 | 714 ms · 714 ms | 1.0 | 1.0 | 1322 |
| L13-abas | local | 1/1 | 0 | 0 | 421 ms · 421 ms | 1.0 | 1.0 | 1341 |
| L14-rolar-ate-o-fim | local | 1/1 | 0 | 0 | 447 ms · 493 ms | 1.0 | 4.0 | 5107 |
| L15-quantidade-sem-enter | local | 1/1 | 0 | 0 | 562 ms · 562 ms | 1.0 | 1.0 | 1273 |
| L16-busca-com-checkout | local | 1/1 | 0 | 0 | 1206 ms · 1206 ms | 1.0 | 1.0 | 1254 |
| L17-comprar-agora-nao-pedido | local | 1/1 | 0 | 0 | 449 ms · 449 ms | 1.0 | 1.0 | 1255 |
| N01-anuncio-primeiro-resultado | local | 1/1 | 0 | 0 | 1096 ms · 1096 ms | 1.0 | 1.0 | 1429 |
| N02-anuncio-carrinho | local | 1/1 | 0 | 0 | 449 ms · 449 ms | 1.0 | 1.0 | 1424 |
| N03-busca-lenta-xhr | local | 1/1 | 0 | 0 | 9589 ms · 9589 ms | 1.0 | 1.0 | 1574 |
| N04-filtro-lento-xhr | local | 1/1 | 0 | 0 | 8746 ms · 8746 ms | 1.0 | 1.0 | 1262 |
| N05-autocomplete-cidade | local | 1/1 | 0 | 0 | 988 ms · 1470 ms | 1.0 | 2.0 | 2822 |
| N06-autocomplete-busca | local | 1/1 | 0 | 0 | 1543 ms · 1543 ms | 1.0 | 1.0 | 1334 |
| N07-rerender-lista | local | 1/1 | 0 | 0 | 467 ms · 467 ms | 1.0 | 1.0 | 1407 |
| N08-rerender-remover | local | 1/1 | 0 | 0 | 445 ms · 445 ms | 1.0 | 1.0 | 1328 |
| N09-carrinho-quantidade | local | 1/1 | 0 | 0 | 1681 ms · 1681 ms | 1.0 | 1.0 | 1285 |
| N10-carrinho-idempotente | local | 1/1 | 0 | 0 | 397 ms · 431 ms | 2.0 | 2.0 | 2732 |
| P01-wikipedia-busca | public | 1/1 | 0 | 0 | 863 ms · 863 ms | 1.0 | 0.0 | 0 |
| P02-wikipedia-link | public | 1/1 | 0 | 0 | 1011 ms · 1011 ms | 1.0 | 1.0 | 7917 |
| P03-saucedemo-carrinho | public | 1/1 | 0 | 0 | 488 ms · 700 ms | 1.0 | 3.0 | 7956 |
| P04-saucedemo-checkout | public | 1/1 | 0 | 0 | 471 ms · 844 ms | 1.0 | 5.0 | 11968 |
| P05-amazon-busca-adicionar | sonda | 0/1 | 0 | 0 | 1460 ms · 1460 ms | 1.0 | 1.0 | 1030 |
| P06-amazon-produto-adicionar | sonda | 0/1 | 0 | 0 | 1304 ms · 1304 ms | 1.0 | 1.0 | 1035 |

Falhas:
- **P05-amazon-busca-adicionar** (sonda) — 1/1: parou: crash ×1. Site de terceiros: captcha, A/B e variação de layout derrubam a tarefa por motivos alheios ao piloto [relatório do act não reconhecido]
- **P06-amazon-produto-adicionar** (sonda) — 1/1: parou: crash ×1. Mesma fragilidade da P05, com uma página a mais [relatório do act não reconhecido]
