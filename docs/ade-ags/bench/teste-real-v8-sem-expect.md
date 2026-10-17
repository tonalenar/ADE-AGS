### teste-real-v8-sem-expect — modo real · 2a7c9146 · 2026-10-17T18:43:35.580Z

Semente 1 · 1 repetição(ões) por tarefa · ordem da lista · impressão dos números `a6f1bc27`

| métrica | **portão** (sem sondas) | locais | públicas | sondas (fora dos portões) |
|---|---|---|---|---|
| rodadas (tarefas) | 100 (100) | 100 (100) | 0 (0) | 0 (0) |
| sucesso (critério vale, nada proibido) | 99/100 (99%) | 99/100 (99%) | — | — |
| sucesso IC 95% (Wilson) | 94.6% – 99.8% | 94.6% – 99.8% | — | — |
| SPRT: meta ≥ 98% (contra ≤ 95%) | rodar mais | rodar mais | — | — |
| erro silencioso (falso «feito» + violações), teto IC 95% | 0/100 · até 3.7% | 0/100 · até 3.7% | — | — |
| falso «feito» | 0 | 0 | 0 | 0 |
| falso «parou» | 0 | 0 | 0 | 0 |
| NÃO CONFERE (pegou falso «feito») | 0 | 0 | 0 | 0 |
| «verificado» errado (meta 0) | 0 | 0 | 0 | 0 |
| violações | 0 | 0 | 0 | 0 |
| tempo por passo p50 · p95 | 912 ms · 3242 ms | 912 ms · 3242 ms | 0 ms · 0 ms | 0 ms · 0 ms |
| tempo por `act` p50 · p95 | 1249 ms · 5082 ms | 1249 ms · 5082 ms | 0 ms · 0 ms | 0 ms · 0 ms |
| `act` por tarefa (média) | 1.00 | 1.00 | 0.00 | 0.00 |
| travamentos da janela | 0 | 0 | 0 | 0 |
| lag máx. da janela | 26 ms | 26 ms | — | — |
| consultas ao Jev por tarefa (média) | 2.1 | 2.1 | 0.0 | 0.0 |
| tokens por tarefa (média) | 3019 | 3019 | — | — |
| bytes por consulta p50 · p95 | 4598 · 5418 | 4598 · 5418 | — | — |
| latência por consulta p50 · p95 | 294 ms · 339 ms | 294 ms · 339 ms | — | — |

Por tarefa (sondas fora dos portões):

| id | tipo | sucesso | falso feito | falso parou | passo p50 · p95 | act | consultas | tokens |
|---|---|---|---|---|---|---|---|---|
| T-adicionar-141 | local | 1/1 | 0 | 0 | 433 ms · 433 ms | 1.0 | 3.0 | 5182 |
| T-adicionar-142 | local | 1/1 | 0 | 0 | 472 ms · 472 ms | 1.0 | 3.0 | 5705 |
| T-adicionar-143 | local | 1/1 | 0 | 0 | 444 ms · 444 ms | 1.0 | 3.0 | 5716 |
| T-adicionar-144 | local | 1/1 | 0 | 0 | 439 ms · 439 ms | 1.0 | 3.0 | 5519 |
| T-adicionar-145 | local | 1/1 | 0 | 0 | 481 ms · 481 ms | 1.0 | 3.0 | 5751 |
| T-adicionar-146 | local | 1/1 | 0 | 0 | 436 ms · 436 ms | 1.0 | 3.0 | 5159 |
| T-adicionar-147 | local | 1/1 | 0 | 0 | 439 ms · 439 ms | 1.0 | 2.0 | 3550 |
| T-adicionar-148 | local | 1/1 | 0 | 0 | 432 ms · 432 ms | 1.0 | 3.0 | 5607 |
| T-adicionar-149 | local | 1/1 | 0 | 0 | 444 ms · 444 ms | 1.0 | 2.0 | 3652 |
| T-adicionar-150 | local | 1/1 | 0 | 0 | 455 ms · 455 ms | 1.0 | 3.0 | 5102 |
| T-adicionar-151 | local | 1/1 | 0 | 0 | 432 ms · 432 ms | 1.0 | 3.0 | 5674 |
| T-adicionar-152 | local | 1/1 | 0 | 0 | 428 ms · 428 ms | 1.0 | 2.0 | 3488 |
| T-adicionar-153 | local | 1/1 | 0 | 0 | 440 ms · 440 ms | 1.0 | 3.0 | 5082 |
| T-adicionar-154 | local | 1/1 | 0 | 0 | 428 ms · 428 ms | 1.0 | 3.0 | 5332 |
| T-adicionar-155 | local | 1/1 | 0 | 0 | 424 ms · 424 ms | 1.0 | 3.0 | 5438 |
| T-adicionar-156 | local | 1/1 | 0 | 0 | 412 ms · 412 ms | 1.0 | 3.0 | 5243 |
| T-adicionar-157 | local | 1/1 | 0 | 0 | 423 ms · 423 ms | 1.0 | 3.0 | 5381 |
| T-adicionar-158 | local | 1/1 | 0 | 0 | 460 ms · 460 ms | 1.0 | 3.0 | 5063 |
| T-adicionar-159 | local | 1/1 | 0 | 0 | 436 ms · 436 ms | 1.0 | 2.0 | 3861 |
| T-adicionar-160 | local | 1/1 | 0 | 0 | 420 ms · 420 ms | 1.0 | 2.0 | 3685 |
| T-busca-141 | local | 1/1 | 0 | 0 | 1145 ms · 1145 ms | 1.0 | 1.0 | 1262 |
| T-busca-142 | local | 1/1 | 0 | 0 | 1124 ms · 1124 ms | 1.0 | 1.0 | 1262 |
| T-busca-143 | local | 1/1 | 0 | 0 | 1160 ms · 1160 ms | 1.0 | 1.0 | 1450 |
| T-busca-144 | local | 1/1 | 0 | 0 | 1159 ms · 1159 ms | 1.0 | 1.0 | 1259 |
| T-busca-145 | local | 1/1 | 0 | 0 | 1133 ms · 1133 ms | 1.0 | 1.0 | 1445 |
| T-busca-146 | local | 1/1 | 0 | 0 | 1158 ms · 1158 ms | 1.0 | 1.0 | 1444 |
| T-busca-147 | local | 1/1 | 0 | 0 | 1117 ms · 1117 ms | 1.0 | 1.0 | 1445 |
| T-busca-148 | local | 1/1 | 0 | 0 | 1125 ms · 1125 ms | 1.0 | 1.0 | 1267 |
| T-busca-149 | local | 1/1 | 0 | 0 | 1134 ms · 1134 ms | 1.0 | 1.0 | 1442 |
| T-busca-150 | local | 1/1 | 0 | 0 | 1120 ms · 1120 ms | 1.0 | 1.0 | 1442 |
| T-busca-151 | local | 1/1 | 0 | 0 | 1139 ms · 1139 ms | 1.0 | 1.0 | 1261 |
| T-busca-152 | local | 1/1 | 0 | 0 | 1124 ms · 1124 ms | 1.0 | 1.0 | 1441 |
| T-busca-153 | local | 1/1 | 0 | 0 | 1143 ms · 1143 ms | 1.0 | 1.0 | 1446 |
| T-busca-154 | local | 1/1 | 0 | 0 | 1146 ms · 1146 ms | 1.0 | 1.0 | 1451 |
| T-busca-155 | local | 1/1 | 0 | 0 | 1134 ms · 1134 ms | 1.0 | 1.0 | 1253 |
| T-busca-156 | local | 1/1 | 0 | 0 | 1120 ms · 1120 ms | 1.0 | 1.0 | 1260 |
| T-busca-157 | local | 1/1 | 0 | 0 | 1136 ms · 1136 ms | 1.0 | 1.0 | 1443 |
| T-busca-158 | local | 1/1 | 0 | 0 | 1158 ms · 1158 ms | 1.0 | 1.0 | 1443 |
| T-busca-159 | local | 1/1 | 0 | 0 | 1136 ms · 1136 ms | 1.0 | 1.0 | 1260 |
| T-busca-160 | local | 1/1 | 0 | 0 | 1121 ms · 1121 ms | 1.0 | 1.0 | 1262 |
| T-filtro-141 | local | 1/1 | 0 | 0 | 721 ms · 721 ms | 1.0 | 2.0 | 2669 |
| T-filtro-142 | local | 1/1 | 0 | 0 | 4766 ms · 4766 ms | 1.0 | 2.0 | 2665 |
| T-filtro-143 | local | 1/1 | 0 | 0 | 756 ms · 756 ms | 1.0 | 2.0 | 2665 |
| T-filtro-144 | local | 1/1 | 0 | 0 | 740 ms · 740 ms | 1.0 | 2.0 | 2668 |
| T-filtro-145 | local | 1/1 | 0 | 0 | 776 ms · 776 ms | 1.0 | 2.0 | 2661 |
| T-filtro-146 | local | 1/1 | 0 | 0 | 4752 ms · 4752 ms | 1.0 | 2.0 | 2668 |
| T-filtro-147 | local | 1/1 | 0 | 0 | 4823 ms · 4823 ms | 1.0 | 2.0 | 2654 |
| T-filtro-148 | local | 1/1 | 0 | 0 | 2745 ms · 2745 ms | 1.0 | 2.0 | 2657 |
| T-filtro-149 | local | 1/1 | 0 | 0 | 785 ms · 785 ms | 1.0 | 2.0 | 2654 |
| T-filtro-150 | local | 1/1 | 0 | 0 | 1531 ms · 1531 ms | 1.0 | 2.0 | 2671 |
| T-filtro-151 | local | 1/1 | 0 | 0 | 4792 ms · 4792 ms | 1.0 | 2.0 | 2669 |
| T-filtro-152 | local | 1/1 | 0 | 0 | 2724 ms · 2724 ms | 1.0 | 2.0 | 2669 |
| T-filtro-153 | local | 1/1 | 0 | 0 | 4745 ms · 4745 ms | 1.0 | 2.0 | 2651 |
| T-filtro-154 | local | 1/1 | 0 | 0 | 1561 ms · 1561 ms | 1.0 | 2.0 | 2661 |
| T-filtro-155 | local | 1/1 | 0 | 0 | 737 ms · 737 ms | 1.0 | 2.0 | 2665 |
| T-filtro-156 | local | 1/1 | 0 | 0 | 4731 ms · 4731 ms | 1.0 | 2.0 | 2668 |
| T-filtro-157 | local | 1/1 | 0 | 0 | 1533 ms · 1533 ms | 1.0 | 2.0 | 2651 |
| T-filtro-158 | local | 1/1 | 0 | 0 | 1539 ms · 1539 ms | 1.0 | 2.0 | 2654 |
| T-filtro-159 | local | 1/1 | 0 | 0 | 4756 ms · 4756 ms | 1.0 | 2.0 | 2657 |
| T-filtro-160 | local | 1/1 | 0 | 0 | 723 ms · 723 ms | 1.0 | 2.0 | 2671 |
| T-icone-141 | local | 1/1 | 0 | 0 | 1001 ms · 1001 ms | 1.0 | 2.0 | 2287 |
| T-icone-142 | local | 1/1 | 0 | 0 | 1476 ms · 1476 ms | 1.0 | 2.0 | 2290 |
| T-icone-143 | local | 1/1 | 0 | 0 | 1531 ms · 1531 ms | 1.0 | 2.0 | 2290 |
| T-icone-144 | local | 1/1 | 0 | 0 | 912 ms · 912 ms | 1.0 | 2.0 | 2283 |
| T-icone-145 | local | 1/1 | 0 | 0 | 887 ms · 887 ms | 1.0 | 2.0 | 2274 |
| T-icone-146 | local | 1/1 | 0 | 0 | 946 ms · 946 ms | 1.0 | 2.0 | 2278 |
| T-icone-147 | local | 1/1 | 0 | 0 | 1458 ms · 1458 ms | 1.0 | 2.0 | 2295 |
| T-icone-148 | local | 1/1 | 0 | 0 | 1117 ms · 1117 ms | 1.0 | 3.0 | 3549 |
| T-icone-149 | local | 1/1 | 0 | 0 | 917 ms · 917 ms | 1.0 | 2.0 | 2278 |
| T-icone-150 | local | 1/1 | 0 | 0 | 1159 ms · 1159 ms | 1.0 | 3.0 | 3565 |
| T-icone-151 | local | 1/1 | 0 | 0 | 880 ms · 880 ms | 1.0 | 2.0 | 2282 |
| T-icone-152 | local | 1/1 | 0 | 0 | 1128 ms · 1128 ms | 1.0 | 3.0 | 3565 |
| T-icone-153 | local | 1/1 | 0 | 0 | 912 ms · 912 ms | 1.0 | 2.0 | 2283 |
| T-icone-154 | local | 1/1 | 0 | 0 | 890 ms · 890 ms | 1.0 | 2.0 | 2283 |
| T-icone-155 | local | 1/1 | 0 | 0 | 1148 ms · 1148 ms | 1.0 | 3.0 | 3553 |
| T-icone-156 | local | 1/1 | 0 | 0 | 1198 ms · 1198 ms | 1.0 | 3.0 | 3553 |
| T-icone-157 | local | 1/1 | 0 | 0 | 882 ms · 882 ms | 1.0 | 2.0 | 2274 |
| T-icone-158 | local | 0/1 | 0 | 0 | 863 ms · 863 ms | 1.0 | 3.0 | 3569 |
| T-icone-159 | local | 1/1 | 0 | 0 | 1159 ms · 1159 ms | 1.0 | 3.0 | 3568 |
| T-icone-160 | local | 1/1 | 0 | 0 | 900 ms · 900 ms | 1.0 | 2.0 | 2286 |
| T-formulario-141 | local | 1/1 | 0 | 0 | 706 ms · 706 ms | 1.0 | 2.0 | 2772 |
| T-formulario-142 | local | 1/1 | 0 | 0 | 946 ms · 946 ms | 1.0 | 2.0 | 2894 |
| T-formulario-143 | local | 1/1 | 0 | 0 | 963 ms · 963 ms | 1.0 | 2.0 | 2919 |
| T-formulario-144 | local | 1/1 | 0 | 0 | 720 ms · 806 ms | 1.0 | 3.0 | 4455 |
| T-formulario-145 | local | 1/1 | 0 | 0 | 686 ms · 686 ms | 1.0 | 2.0 | 2783 |
| T-formulario-146 | local | 1/1 | 0 | 0 | 694 ms · 826 ms | 1.0 | 3.0 | 4400 |
| T-formulario-147 | local | 1/1 | 0 | 0 | 703 ms · 703 ms | 1.0 | 2.0 | 2777 |
| T-formulario-148 | local | 1/1 | 0 | 0 | 697 ms · 816 ms | 1.0 | 3.0 | 4455 |
| T-formulario-149 | local | 1/1 | 0 | 0 | 824 ms · 824 ms | 1.0 | 2.0 | 2843 |
| T-formulario-150 | local | 1/1 | 0 | 0 | 847 ms · 847 ms | 1.0 | 2.0 | 2845 |
| T-formulario-151 | local | 1/1 | 0 | 0 | 818 ms · 818 ms | 1.0 | 2.0 | 2829 |
| T-formulario-152 | local | 1/1 | 0 | 0 | 826 ms · 826 ms | 1.0 | 2.0 | 2847 |
| T-formulario-153 | local | 1/1 | 0 | 0 | 846 ms · 846 ms | 1.0 | 2.0 | 2830 |
| T-formulario-154 | local | 1/1 | 0 | 0 | 556 ms · 561 ms | 1.0 | 3.0 | 4272 |
| T-formulario-155 | local | 1/1 | 0 | 0 | 686 ms · 686 ms | 1.0 | 2.0 | 2787 |
| T-formulario-156 | local | 1/1 | 0 | 0 | 945 ms · 945 ms | 1.0 | 2.0 | 2892 |
| T-formulario-157 | local | 1/1 | 0 | 0 | 682 ms · 799 ms | 1.0 | 3.0 | 4445 |
| T-formulario-158 | local | 1/1 | 0 | 0 | 557 ms · 558 ms | 1.0 | 3.0 | 4308 |
| T-formulario-159 | local | 1/1 | 0 | 0 | 868 ms · 868 ms | 1.0 | 2.0 | 2844 |
| T-formulario-160 | local | 1/1 | 0 | 0 | 683 ms · 805 ms | 1.0 | 3.0 | 4402 |

Falhas:
- **T-icone-158** — 1/1: parou: stuck ×1
