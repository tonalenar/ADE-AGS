### teste-real-v7-sem-expect — modo real · 32509ea7 · 2026-10-17T17:54:04.522Z

Semente 1 · 1 repetição(ões) por tarefa · ordem da lista · impressão dos números `e3ce331c`

| métrica | **portão** (sem sondas) | locais | públicas | sondas (fora dos portões) |
|---|---|---|---|---|
| rodadas (tarefas) | 100 (100) | 100 (100) | 0 (0) | 0 (0) |
| sucesso (critério vale, nada proibido) | 98/100 (98%) | 98/100 (98%) | — | — |
| sucesso IC 95% (Wilson) | 93.0% – 99.4% | 93.0% – 99.4% | — | — |
| SPRT: meta ≥ 98% (contra ≤ 95%) | rodar mais | rodar mais | — | — |
| erro silencioso (falso «feito» + violações), teto IC 95% | 2/100 · até 7.0% | 2/100 · até 7.0% | — | — |
| falso «feito» | 2 | 2 | 0 | 0 |
| falso «parou» | 0 | 0 | 0 | 0 |
| NÃO CONFERE (pegou falso «feito») | 0 | 0 | 0 | 0 |
| «verificado» errado (meta 0) | 0 | 0 | 0 | 0 |
| violações | 0 | 0 | 0 | 0 |
| tempo por passo p50 · p95 | 919 ms · 2748 ms | 919 ms · 2748 ms | 0 ms · 0 ms | 0 ms · 0 ms |
| tempo por `act` p50 · p95 | 1248 ms · 3563 ms | 1248 ms · 3563 ms | 0 ms · 0 ms | 0 ms · 0 ms |
| `act` por tarefa (média) | 1.00 | 1.00 | 0.00 | 0.00 |
| travamentos da janela | 0 | 0 | 0 | 0 |
| lag máx. da janela | 25 ms | 25 ms | — | — |
| consultas ao Jev por tarefa (média) | 2.1 | 2.1 | 0.0 | 0.0 |
| tokens por tarefa (média) | 2972 | 2972 | — | — |
| bytes por consulta p50 · p95 | 4565 · 5438 | 4565 · 5438 | — | — |
| latência por consulta p50 · p95 | 303 ms · 343 ms | 303 ms · 343 ms | — | — |

Por tarefa (sondas fora dos portões):

| id | tipo | sucesso | falso feito | falso parou | passo p50 · p95 | act | consultas | tokens |
|---|---|---|---|---|---|---|---|---|
| T-adicionar-121 | local | 1/1 | 0 | 0 | 436 ms · 436 ms | 1.0 | 3.0 | 5173 |
| T-adicionar-122 | local | 1/1 | 0 | 0 | 439 ms · 439 ms | 1.0 | 2.0 | 3506 |
| T-adicionar-123 | local | 1/1 | 0 | 0 | 432 ms · 432 ms | 1.0 | 2.0 | 3516 |
| T-adicionar-124 | local | 1/1 | 0 | 0 | 444 ms · 444 ms | 1.0 | 3.0 | 5116 |
| T-adicionar-125 | local | 1/1 | 0 | 0 | 433 ms · 433 ms | 1.0 | 3.0 | 5555 |
| T-adicionar-126 | local | 1/1 | 0 | 0 | 428 ms · 428 ms | 1.0 | 3.0 | 5721 |
| T-adicionar-127 | local | 1/1 | 0 | 0 | 427 ms · 427 ms | 1.0 | 2.0 | 3604 |
| T-adicionar-128 | local | 1/1 | 0 | 0 | 449 ms · 449 ms | 1.0 | 2.0 | 3372 |
| T-adicionar-129 | local | 1/1 | 0 | 0 | 441 ms · 441 ms | 1.0 | 3.0 | 5648 |
| T-adicionar-130 | local | 1/1 | 0 | 0 | 427 ms · 427 ms | 1.0 | 2.0 | 3865 |
| T-adicionar-131 | local | 1/1 | 0 | 0 | 442 ms · 442 ms | 1.0 | 2.0 | 3790 |
| T-adicionar-132 | local | 1/1 | 0 | 0 | 429 ms · 429 ms | 1.0 | 3.0 | 5022 |
| T-adicionar-133 | local | 1/1 | 0 | 0 | 477 ms · 477 ms | 1.0 | 2.0 | 3595 |
| T-adicionar-134 | local | 1/1 | 0 | 0 | 442 ms · 454 ms | 1.0 | 4.0 | 6800 |
| T-adicionar-135 | local | 1/1 | 0 | 0 | 432 ms · 432 ms | 1.0 | 2.0 | 3422 |
| T-adicionar-136 | local | 1/1 | 0 | 0 | 436 ms · 436 ms | 1.0 | 3.0 | 5528 |
| T-adicionar-137 | local | 1/1 | 0 | 0 | 436 ms · 436 ms | 1.0 | 3.0 | 5607 |
| T-adicionar-138 | local | 1/1 | 0 | 0 | 439 ms · 439 ms | 1.0 | 3.0 | 5760 |
| T-adicionar-139 | local | 1/1 | 0 | 0 | 438 ms · 438 ms | 1.0 | 3.0 | 5126 |
| T-adicionar-140 | local | 1/1 | 0 | 0 | 425 ms · 425 ms | 1.0 | 3.0 | 5337 |
| T-busca-121 | local | 1/1 | 0 | 0 | 1166 ms · 1166 ms | 1.0 | 1.0 | 1447 |
| T-busca-122 | local | 1/1 | 0 | 0 | 1155 ms · 1155 ms | 1.0 | 1.0 | 1451 |
| T-busca-123 | local | 1/1 | 0 | 0 | 1152 ms · 1152 ms | 1.0 | 1.0 | 1445 |
| T-busca-124 | local | 1/1 | 0 | 0 | 1175 ms · 1175 ms | 1.0 | 1.0 | 1259 |
| T-busca-125 | local | 1/1 | 0 | 0 | 1155 ms · 1155 ms | 1.0 | 1.0 | 1448 |
| T-busca-126 | local | 1/1 | 0 | 0 | 1167 ms · 1167 ms | 1.0 | 1.0 | 1260 |
| T-busca-127 | local | 1/1 | 0 | 0 | 1150 ms · 1150 ms | 1.0 | 1.0 | 1260 |
| T-busca-128 | local | 1/1 | 0 | 0 | 1155 ms · 1155 ms | 1.0 | 1.0 | 1452 |
| T-busca-129 | local | 1/1 | 0 | 0 | 1156 ms · 1156 ms | 1.0 | 1.0 | 1446 |
| T-busca-130 | local | 1/1 | 0 | 0 | 1155 ms · 1155 ms | 1.0 | 1.0 | 1253 |
| T-busca-131 | local | 1/1 | 0 | 0 | 1150 ms · 1150 ms | 1.0 | 1.0 | 1252 |
| T-busca-132 | local | 1/1 | 0 | 0 | 1142 ms · 1142 ms | 1.0 | 1.0 | 1253 |
| T-busca-133 | local | 1/1 | 0 | 0 | 1135 ms · 1135 ms | 1.0 | 1.0 | 1259 |
| T-busca-134 | local | 1/1 | 0 | 0 | 1155 ms · 1155 ms | 1.0 | 1.0 | 1253 |
| T-busca-135 | local | 1/1 | 0 | 0 | 1161 ms · 1161 ms | 1.0 | 1.0 | 1442 |
| T-busca-136 | local | 1/1 | 0 | 0 | 1158 ms · 1158 ms | 1.0 | 1.0 | 1251 |
| T-busca-137 | local | 1/1 | 0 | 0 | 1161 ms · 1161 ms | 1.0 | 1.0 | 1443 |
| T-busca-138 | local | 1/1 | 0 | 0 | 1151 ms · 1151 ms | 1.0 | 1.0 | 1265 |
| T-busca-139 | local | 1/1 | 0 | 0 | 1147 ms · 1147 ms | 1.0 | 1.0 | 1253 |
| T-busca-140 | local | 1/1 | 0 | 0 | 1177 ms · 1177 ms | 1.0 | 1.0 | 1260 |
| T-filtro-121 | local | 1/1 | 0 | 0 | 2807 ms · 2807 ms | 1.0 | 2.0 | 2657 |
| T-filtro-122 | local | 1/1 | 0 | 0 | 733 ms · 733 ms | 1.0 | 2.0 | 2657 |
| T-filtro-123 | local | 1/1 | 0 | 0 | 1569 ms · 1569 ms | 1.0 | 2.0 | 2651 |
| T-filtro-124 | local | 1/1 | 0 | 0 | 758 ms · 758 ms | 1.0 | 2.0 | 2649 |
| T-filtro-125 | local | 1/1 | 0 | 0 | 1561 ms · 1561 ms | 1.0 | 2.0 | 2665 |
| T-filtro-126 | local | 1/1 | 0 | 0 | 2745 ms · 2745 ms | 1.0 | 2.0 | 2665 |
| T-filtro-127 | local | 1/1 | 0 | 0 | 5023 ms · 5023 ms | 1.0 | 2.0 | 2665 |
| T-filtro-128 | local | 1/1 | 0 | 0 | 1556 ms · 1556 ms | 1.0 | 2.0 | 2665 |
| T-filtro-129 | local | 1/1 | 0 | 0 | 1577 ms · 1577 ms | 1.0 | 2.0 | 2657 |
| T-filtro-130 | local | 1/1 | 0 | 0 | 4799 ms · 4799 ms | 1.0 | 2.0 | 2649 |
| T-filtro-131 | local | 1/1 | 0 | 0 | 756 ms · 756 ms | 1.0 | 2.0 | 2669 |
| T-filtro-132 | local | 1/1 | 0 | 0 | 4761 ms · 4761 ms | 1.0 | 2.0 | 2669 |
| T-filtro-133 | local | 1/1 | 0 | 0 | 4803 ms · 4803 ms | 1.0 | 2.0 | 2649 |
| T-filtro-134 | local | 1/1 | 0 | 0 | 2831 ms · 2831 ms | 1.0 | 2.0 | 2668 |
| T-filtro-135 | local | 1/1 | 0 | 0 | 1559 ms · 1559 ms | 1.0 | 2.0 | 2654 |
| T-filtro-136 | local | 1/1 | 0 | 0 | 734 ms · 734 ms | 1.0 | 2.0 | 2657 |
| T-filtro-137 | local | 1/1 | 0 | 0 | 1612 ms · 1612 ms | 1.0 | 2.0 | 2657 |
| T-filtro-138 | local | 1/1 | 0 | 0 | 737 ms · 737 ms | 1.0 | 2.0 | 2657 |
| T-filtro-139 | local | 1/1 | 0 | 0 | 2756 ms · 2756 ms | 1.0 | 2.0 | 2649 |
| T-filtro-140 | local | 1/1 | 0 | 0 | 775 ms · 775 ms | 1.0 | 2.0 | 2668 |
| T-icone-121 | local | 1/1 | 0 | 0 | 1499 ms · 1499 ms | 1.0 | 2.0 | 2291 |
| T-icone-122 | local | 1/1 | 0 | 0 | 1140 ms · 1140 ms | 1.0 | 3.0 | 3578 |
| T-icone-123 | local | 1/1 | 0 | 0 | 927 ms · 927 ms | 1.0 | 2.0 | 2287 |
| T-icone-124 | local | 1/1 | 0 | 0 | 1530 ms · 1530 ms | 1.0 | 2.0 | 2286 |
| T-icone-125 | local | 1/1 | 0 | 0 | 1192 ms · 1192 ms | 1.0 | 3.0 | 3563 |
| T-icone-126 | local | 1/1 | 0 | 0 | 1165 ms · 1165 ms | 1.0 | 3.0 | 3563 |
| T-icone-127 | local | 1/1 | 0 | 0 | 869 ms · 869 ms | 1.0 | 2.0 | 2278 |
| T-icone-128 | local | 1/1 | 0 | 0 | 1143 ms · 1143 ms | 1.0 | 3.0 | 3577 |
| T-icone-129 | local | 0/1 | 1 | 0 | 919 ms · 919 ms | 1.0 | 2.0 | 2287 |
| T-icone-130 | local | 1/1 | 0 | 0 | 893 ms · 893 ms | 1.0 | 2.0 | 2282 |
| T-icone-131 | local | 1/1 | 0 | 0 | 880 ms · 880 ms | 1.0 | 2.0 | 2286 |
| T-icone-132 | local | 1/1 | 0 | 0 | 885 ms · 885 ms | 1.0 | 2.0 | 2287 |
| T-icone-133 | local | 1/1 | 0 | 0 | 1104 ms · 1104 ms | 1.0 | 2.0 | 2278 |
| T-icone-134 | local | 1/1 | 0 | 0 | 1187 ms · 1187 ms | 1.0 | 3.0 | 3559 |
| T-icone-135 | local | 1/1 | 0 | 0 | 918 ms · 918 ms | 1.0 | 2.0 | 2287 |
| T-icone-136 | local | 1/1 | 0 | 0 | 870 ms · 870 ms | 1.0 | 2.0 | 2287 |
| T-icone-137 | local | 1/1 | 0 | 0 | 1168 ms · 1168 ms | 1.0 | 3.0 | 3574 |
| T-icone-138 | local | 1/1 | 0 | 0 | 1157 ms · 1157 ms | 1.0 | 3.0 | 3560 |
| T-icone-139 | local | 0/1 | 1 | 0 | 889 ms · 889 ms | 1.0 | 2.0 | 2286 |
| T-icone-140 | local | 1/1 | 0 | 0 | 894 ms · 894 ms | 1.0 | 2.0 | 2278 |
| T-formulario-121 | local | 1/1 | 0 | 0 | 835 ms · 835 ms | 1.0 | 2.0 | 2853 |
| T-formulario-122 | local | 1/1 | 0 | 0 | 705 ms · 822 ms | 1.0 | 3.0 | 4400 |
| T-formulario-123 | local | 1/1 | 0 | 0 | 839 ms · 839 ms | 1.0 | 2.0 | 2830 |
| T-formulario-124 | local | 1/1 | 0 | 0 | 590 ms · 619 ms | 1.0 | 3.0 | 4310 |
| T-formulario-125 | local | 1/1 | 0 | 0 | 703 ms · 819 ms | 1.0 | 3.0 | 4407 |
| T-formulario-126 | local | 1/1 | 0 | 0 | 976 ms · 976 ms | 1.0 | 2.0 | 2911 |
| T-formulario-127 | local | 1/1 | 0 | 0 | 700 ms · 812 ms | 1.0 | 3.0 | 4429 |
| T-formulario-128 | local | 1/1 | 0 | 0 | 708 ms · 708 ms | 1.0 | 2.0 | 2793 |
| T-formulario-129 | local | 1/1 | 0 | 0 | 701 ms · 809 ms | 1.0 | 3.0 | 4443 |
| T-formulario-130 | local | 1/1 | 0 | 0 | 701 ms · 701 ms | 1.0 | 2.0 | 2777 |
| T-formulario-131 | local | 1/1 | 0 | 0 | 835 ms · 835 ms | 1.0 | 2.0 | 2859 |
| T-formulario-132 | local | 1/1 | 0 | 0 | 700 ms · 811 ms | 1.0 | 3.0 | 4406 |
| T-formulario-133 | local | 1/1 | 0 | 0 | 816 ms · 816 ms | 1.0 | 2.0 | 2829 |
| T-formulario-134 | local | 1/1 | 0 | 0 | 631 ms · 698 ms | 1.0 | 3.0 | 4371 |
| T-formulario-135 | local | 1/1 | 0 | 0 | 713 ms · 713 ms | 1.0 | 2.0 | 2768 |
| T-formulario-136 | local | 1/1 | 0 | 0 | 949 ms · 949 ms | 1.0 | 2.0 | 2919 |
| T-formulario-137 | local | 1/1 | 0 | 0 | 685 ms · 685 ms | 1.0 | 2.0 | 2787 |
| T-formulario-138 | local | 1/1 | 0 | 0 | 707 ms · 707 ms | 1.0 | 2.0 | 2777 |
| T-formulario-139 | local | 1/1 | 0 | 0 | 1042 ms · 1042 ms | 1.0 | 2.0 | 2909 |
| T-formulario-140 | local | 1/1 | 0 | 0 | 838 ms · 838 ms | 1.0 | 2.0 | 2835 |

Falhas:
- **T-icone-129** — 1/1: falso «feito» ×1
- **T-icone-139** — 1/1: falso «feito» ×1
