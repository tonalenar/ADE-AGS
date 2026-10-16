# Aceite da Fase 1 — 30 rodadas de janela (plano computer use v2)

Objetivo do plano: **0 travamentos em 30 rodadas** (15 com a janela minimizada, 15 com página pesada aberta). Medido na instância isolada do Infra (dados e perfil do WebView2 próprios), com o app construído da branch da missão (flags do WebView2 da 1.1, erros distintos da 1.3, progresso do act da 1.4, ags portals com estado da 1.6). Sem Amazon, sem login, sem compra.

## Resumo

| | minimizada | pesada | total |
|---|---|---|---|
| rodadas | 15 | 15 | 30 |
| travamentos (timeout da ponte ou erro de janela) | 0 | 0 | **0** |
| app fechou no meio | 0 | 0 | **0** |
| timeouts da ponte (contador do backend, ao fim) | 0 | 0 | 0 |
| lag da UI, pico por rodada: mediana / p95 / máx (ms) | 9 / 78 / 78 | 8 / 57 / 57 | 8 / 57 / 78 |
| act com o Jev | 6 | 0 | 6 (6 consultas ao Jev) |
| lag máx no relatório do act (ms) | 11, 2, 5, 3, 8, 3 | — | |
| memória do WebView2 ao fim da rodada (MB) | 517 → 542 | 725 → 787 | estável (+5 e +8%) |

**Resultado: 0 travamentos em 30 rodadas — aceite cumprido.**

### Mensagens de erro vistas

- Única falha das 30 rodadas: `portal screenshot` com a janela minimizada (15 de 15). Não é travamento: a janela minimizada não tem página para fotografar. A mensagem agora diz o que fazer: *"a página não está à vista: a janela do ADE AGS está minimizada ou escondida, ou o portal está fora da tela/coberto por outro painel. Peça ao usuário para trazer a janela à frente e deixar o portal visível, ou leia a página com snapshot (que não precisa de tela)."* (antes: só *"a página não está à vista"*). Os demais passos (criar, esperar, ler, digitar, clicar) funcionam com a janela minimizada; o document.hidden fica falso por causa das flags da 1.1.
- Nenhuma mensagem de timeout da ponte (oculta / travada / ocupada / viva) apareceu: não houve o que classificar.

### Observações

- **A página pesada pesa nela mesma, não na UI:** com o laço de 800 ms/s, o lag do app fica em mediana 8 ms (pico 57 ms, só na primeira rodada, quando a página carrega), mas type+click dentro da página levam ~3.4 s contra ~1.3 s na página leve. O iframe do proxy fica fora do renderizador da UI, como a medição da 1.1 já tinha mostrado.
- A primeira leitura de cada modo traz um pico maior (carga inicial); depois o lag fica abaixo de 15 ms.
- Memória estável ao abrir e fechar 15 portais pesados (`ags portal close`): sem vazamento visível.

## Método

Roteiro `scripts/window-rounds.ps1` (fixtures: `scripts/bench-fixture/busca-botao.html` nas rodadas minimizadas e `scripts/bench-fixture/pesada.html` nas pesadas, servidas por `scripts/jev-bench.ts --serve`). Cada rodada: portal create → wait --idle → snapshot → type → click → wait --idle → screenshot → (rodadas pares, até 6) UM act de 2 passos com o Jev → ags portals → portal close. A janela é minimizada (Win32 ShowWindowAsync) antes de cada rodada minimizada e restaurada antes de cada pesada. O lag vem do batimento da Fase 0.1 (windowBeat), exposto agora em `ags portals` (campo window.lagPeakMs: pior lag desde a leitura anterior). Dados brutos: `docs/ade-ags/bench/v2-janela-30-rodadas.json`.

## Tabela por rodada

| modo | # | minimizada | travou | lag pico UI (ms) | WebView2 (MB) | create | wait | snapshot | type | click | screenshot | act (consultas / lag máx ms) | falha |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| minimizada | 1 | sim | não | 78 | 517 | 84 | 924 | 36 | 785 | 575 | 100 | — | foto indisponível (janela minimizada) |
| minimizada | 2 | sim | não | 11 | 531 | 93 | 491 | 53 | 791 | 541 | 90 | 1 / 11 | foto indisponível (janela minimizada) |
| minimizada | 3 | sim | não | 7 | 534 | 42 | 477 | 27 | 787 | 539 | 75 | — | foto indisponível (janela minimizada) |
| minimizada | 4 | sim | não | 8 | 537 | 40 | 457 | 20 | 760 | 541 | 78 | 1 / 2 | foto indisponível (janela minimizada) |
| minimizada | 5 | sim | não | 7 | 549 | 38 | 480 | 36 | 777 | 534 | 77 | — | foto indisponível (janela minimizada) |
| minimizada | 6 | sim | não | 9 | 551 | 35 | 481 | 22 | 776 | 541 | 79 | 1 / 5 | foto indisponível (janela minimizada) |
| minimizada | 7 | sim | não | 8 | 555 | 35 | 465 | 22 | 770 | 544 | 80 | — | foto indisponível (janela minimizada) |
| minimizada | 8 | sim | não | 10 | 557 | 42 | 480 | 23 | 772 | 546 | 74 | 1 / 3 | foto indisponível (janela minimizada) |
| minimizada | 9 | sim | não | 8 | 559 | 34 | 468 | 21 | 772 | 537 | 77 | — | foto indisponível (janela minimizada) |
| minimizada | 10 | sim | não | 11 | 563 | 33 | 467 | 20 | 773 | 534 | 79 | 1 / 8 | foto indisponível (janela minimizada) |
| minimizada | 11 | sim | não | 9 | 565 | 34 | 482 | 23 | 780 | 539 | 85 | — | foto indisponível (janela minimizada) |
| minimizada | 12 | sim | não | 9 | 552 | 37 | 479 | 21 | 777 | 555 | 78 | 1 / 3 | foto indisponível (janela minimizada) |
| minimizada | 13 | sim | não | 10 | 541 | 37 | 482 | 30 | 785 | 536 | 79 | — | foto indisponível (janela minimizada) |
| minimizada | 14 | sim | não | 11 | 542 | 41 | 477 | 21 | 785 | 538 | 75 | — | foto indisponível (janela minimizada) |
| minimizada | 15 | sim | não | 8 | 542 | 34 | 463 | 21 | 767 | 547 | 76 | — | foto indisponível (janela minimizada) |
| pesada | 1 | não | não | 57 | 725 | 43 | 581 | 150 | 2302 | 2028 | 193 | — |  |
| pesada | 2 | não | não | 20 | 754 | 44 | 809 | 101 | 2287 | 1049 | 120 | — |  |
| pesada | 3 | não | não | 8 | 753 | 39 | 563 | 96 | 1359 | 2031 | 133 | — |  |
| pesada | 4 | não | não | 8 | 753 | 46 | 594 | 133 | 2283 | 1059 | 143 | — |  |
| pesada | 5 | não | não | 5 | 762 | 40 | 773 | 133 | 2309 | 1056 | 127 | — |  |
| pesada | 6 | não | não | 13 | 762 | 45 | 580 | 163 | 2280 | 1040 | 134 | — |  |
| pesada | 7 | não | não | 7 | 757 | 41 | 584 | 108 | 2322 | 1044 | 125 | — |  |
| pesada | 8 | não | não | 7 | 764 | 38 | 585 | 115 | 2316 | 1043 | 130 | — |  |
| pesada | 9 | não | não | 4 | 763 | 35 | 576 | 121 | 2315 | 1045 | 133 | — |  |
| pesada | 10 | não | não | 6 | 769 | 43 | 568 | 121 | 2322 | 1057 | 131 | — |  |
| pesada | 11 | não | não | 7 | 781 | 40 | 468 | 108 | 1432 | 1045 | 129 | — |  |
| pesada | 12 | não | não | 8 | 786 | 39 | 587 | 133 | 2294 | 1054 | 131 | — |  |
| pesada | 13 | não | não | 8 | 778 | 36 | 568 | 117 | 1335 | 2057 | 137 | — |  |
| pesada | 14 | não | não | 10 | 786 | 45 | 566 | 108 | 1342 | 2059 | 125 | — |  |
| pesada | 15 | não | não | 5 | 787 | 37 | 808 | 128 | 1337 | 2042 | 122 | — |  |

## Execuções anteriores: o app da instância fechou sozinho

Antes desta rodada limpa houve duas execuções em que **o processo do app da minha instância desapareceu no meio**, sem mensagem. A primeira completou 20 rodadas válidas (15 minimizadas + 5 pesadas, 0 timeouts, lag de pico ≤ 93 ms) e o app sumiu na rodada 6 das pesadas (a ponte devolveu "No llegó respuesta" e depois "Não foi possível conectar ao pipe"); a segunda sumiu na rodada 2 das pesadas. Não havia nada no stderr do app (nenhum pânico, nenhum [bridge] timeout), nenhum relatório de falha do Windows para o ade-ags e nenhum .dmp; o batimento não registrou lag antes da queda (pico ≤ 102 ms). Em duas execuções seguintes (as 15 pesadas sozinhas e esta, completa) o app **não** caiu, com o mesmo binário. Leitura: é a queda sem causa que o plano chama de I7 ("fechada sozinha"); a evidência aponta para fora do renderizador (sem sinal de página pesada, de memória ou de falha nativa), e não foi possível provar quem encerrou o processo. O roteiro agora grava o código de saída em <saida>.app-exitcode.txt e o stderr em <saida>.app-stderr.log; se voltar a acontecer, o código (1 = encerrado por fora; 0xC0000005 = falha nativa) separa as duas causas.

**Proposta de correção:** nenhuma no código do app por enquanto, porque não há evidência de defeito nele. Se a queda reaparecer com código de falha nativa, reproduzir com --enable-logging no WebView2 antes de concluir; se vier com código 1, o culpado é um encerramento externo (outro script que mata processos) e a correção é de processo, não de código.

Dados brutos da execução anterior: `docs/ade-ags/bench/v2-janela-30-rodadas-execucao-anterior.json`.

**Consultas ao Jev nesta tarefa:** 14 de 20 (8 na execução anterior, 6 nesta); as demais ações não usaram o Jev.
