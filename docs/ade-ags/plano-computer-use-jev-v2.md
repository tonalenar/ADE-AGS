# Computer use com o Jev — auditoria completa e plano v2

Data: 2026-10-16 · Escopo: navegador do canvas + piloto (`ags portal act`, `browser_act`) · Referência: [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (`docs/design.md`, `docs/performance.md`, `snapshot.js`, `browser.py`, `agent.py`, `model.py`, `questions.py`).

Este documento junta (1) o que as rodadas ao vivo de hoje mostraram, (2) a comparação linha a linha com o jev-ultrafast, (3) a auditoria do nosso código e (4) o plano de execução com métricas de aceite. Nada aqui é suposição não marcada: o que não foi confirmado está escrito como **hipótese**.

---

## 1. Onde estamos (medido)

### 1.1 Benchmark da missão (21 tarefas, Jev real, 16/10)

| | Antes | Depois |
|---|---|---|
| critério cumprido sem ajuda à mão | 15/21 (71%) | 19/21 (90%) |
| mediana por passo | 1.368 ms | 661 ms |
| falso «concluído» | 0 | 1 |
| falso «sem certeza» | 3 | 2 |

### 1.2 Rodadas ao vivo com o agente (mesmas 6 tarefas: Wikipedia ×2, loja de demonstração ×2, Amazon ×2)

| Rodada | Resultado | O que quebrou |
|---|---|---|
| 1 | T1–T2 ok; T3 e T4 **falso «feito»**; T1 falso «parou» (sem `--fill`); Amazon não carregou | contagem do carrinho não conferida; Amazon sem runtime |
| 2 | portais não criam: «a janela não respondeu a tempo» ×3; T2 travou 2× ~2 min | janela/frontend sem resposta |
| 3 | T1–T4 ok em 1 `act`; T5 falhou; T6 **falso «feito»** (a Amazon deu erro ao remover) | escolha de resultado com anúncios; remoção sem conferência |
| 4 | T1 e T5 pararam «sem certeza» (leu a página antes da busca carregar); T5 **falso «feito»** sobre «Algo deu errado»; janela travou ~2 min | busca assíncrona; página de erro aceita como sucesso |
| 5 | T1–T4 e T6 em 1 `act` cada (0,7–1,7 s); T5 em 3 `act` (carrinho com 2 unidades); janela travou 1 min 55 s | espera de busca lenta; histórico perdido entre `act`; janela |

Tempo de cada `act` bem-sucedido: 0,5 a 2,6 s. O resto do tempo de parede é turno do agente (modelo grande) e travamentos da janela.

### 1.3 Causas já encontradas e corrigidas hoje (na `dev`)

- **Amazon nunca carregava:** o proxy não pedia `Accept-Encoding` e a Amazon respondia gzip; o proxy só injeta o runtime em HTML sem compressão. Agora pede `identity` e descomprime gzip/deflate de reserva (`ee3587cc`).
- **`about:blank` virava erro de porta** (`https://about:blank`): agora é página vazia (`85872061`).
- **Falso «feito»:** conferência da página antes de aceitar «feito» (contagem de itens, «vazio», remoção, página de erro) (`f95928a5`, `480ed5c9`).
- **Pesquisa sem `--fill`:** recusa antes de tocar em nada.
- **`act` que falha no meio perdia o relatório:** agora sai parcial.
- **Busca com Enter lida cedo demais:** espera a rede assentar e relê (até 3×).

### 1.4 O que continua aberto

1. Travamento da janela (3 de 5 rodadas; 1 min 55 s a ~2 min cada) — **causa não confirmada**.
2. Histórico do piloto zera a cada `act` (T5 adicionou o item duas vezes).
3. Escolha entre resultados com anúncios («patrocinado»).
4. Espera de página depende de tempos fixos, não do estado real da navegação (a Amazon leva ~8 s).
5. «Feito» ainda é uma opinião (probabilidade + heurísticas), não uma verificação.
6. Resumo do `act` corta a parte útil da página (caixa lateral da Wikipedia).
7. `ags` não tem comando para fechar portal.

---

## 2. Comparação com o jev-ultrafast

| Tema | jev-ultrafast | Nós hoje | Veredito |
|---|---|---|---|
| Uma consulta = operação + alvo de cada operação (fan-out) | sim | sim (`operacao`, `alvo_click/type/select`) | **igual** |
| Regras de «próxima ação» enviadas em cada pergunta | sim (`NEXT_ACTION` + `TARGET`) | sim, versão própria (`browse.rs`) | **igual**; falta cobrir anúncios, quantidade e «não repetir ação já feita» |
| Pergunta direta de fim | não (usa a opção `DONE`) | sim (`concluido`) | **à frente**, mas custa uma pergunta por consulta |
| Texto a digitar | **pequeno LLM** gera o valor a partir do objetivo, com JSON validado e cache invalidado após mutação | só `--fill` do agente; recusamos sem ele | **atrás**: o agente precisa saber o campo e o valor |
| Snapshot | 1 chamada no navegador; identidade de nó (WeakMap) + Map; até 250 candidatos; texto visível ≤ 6000 | `snapshot` próprio com refs, janela + arredores, 100 por pergunta | **parecido**; falta guarda semântica por elemento |
| Frescor (stale) | `fresh()` compara documento, URL, viewport, valores de formulário, alvo e contexto próximo **antes** de clicar; se mudou, observa de novo sem ter agido | só «o ref ainda está conectado» (`isConnected`) | **atrás**: um clique pode cair num nó reaproveitado com outro conteúdo |
| Espera depois da ação | 2 quadros ou 50 ms; combobox espera opções visíveis (≤ 200 ms) | `settle` 60–350 ms; espera de navegação só se o resultado diz `navigated` | **atrás** em busca/autocomplete e navegação atrasada |
| Mutação não é repetida por recuperação de transporte | sim; ação registrada antes da próxima observação | parcial: relatório parcial agora, mas histórico some entre `act` | **atrás** |
| Orçamento | 60 ações, 120 pedidos | `--steps` (máx. definido), 3 fotos | **igual** em espírito |
| DONE ≠ prova | «verificação independente decide» | heurísticas de contradição | **atrás**: falta verificação explícita pedida pelo agente |
| Janela em segundo plano | `Emulation.setFocusEmulationEnabled` (rAF corre em aba de fundo) | iframe dentro da janela do app; sem proteção contra throttling | **atrás** (provável relação com os travamentos) |
| Cliente HTTP | HTTP/2, repetição em 429/503/529 com backoff | cliente único (`OnceLock`), sem reuso comprovado de H2 nem backoff | **atrás** |
| Latência mediana do Jev | **178 ms** | 460–1.700 ms por consulta (inclui varredura de segredos e IPC) | **a investigar** (payload e rede) |
| Medição | 6 execuções alternadas, JSON de evidência por execução | 21 tarefas × 3 rodadas, relatório | **parecido**; falta repetição por tarefa e p95 |

Diferenças que NÃO devemos copiar: eles controlam um Chrome por CDP (nós rodamos num iframe com proxy, o que nos dá cookies/CORS próprios mas também o problema do runtime não injetado e do congelamento); a Amazon/WAF não é caso deles.

---

## 3. Auditoria do nosso código (achados)

Severidade: **A** quebra o resultado ou o uso; **M** custa tempo/precisão; **B** polimento.

### 3.1 Infraestrutura (janela, proxy, ponte)

| # | Achado | Sev. | Evidência |
|---|---|---|---|
| I1 | A janela deixa de responder por ~2 min durante `act`/criação de portal. O erro vem de `ask_frontend` (`ipc/bridge.rs`, tempo limite do `recv_timeout`): o **frontend não respondeu**, não o piloto. **Duas hipóteses**: (a) janela minimizada/oculta → WebView2 suspende/estrangula; (b) página pesada (Amazon, ~1,1 MB de HTML e centenas de scripts) monopoliza o renderizador compartilhado com a UI do app (o iframe do proxy é de outra origem, mas o WebView2 nem sempre isola em outro processo). | **A** | rodadas 2, 4 e 5; `portal screenshot` devolveu «a página não está à vista» na janela oculta |
| I2 | `tauri.conf.json` não passa `additionalBrowserArgs`: nada impede `CalculateNativeWinOcclusion`/backgrounding do Chromium. | **A** | config atual só tem título/tamanho/transparência |
| I3 | O proxy só injeta o runtime em HTML sem `content-encoding`. gzip/deflate agora são descomprimidos; **brotli e zstd ainda passam sem injeção**. | M | `proxy.rs`: `inflate_as` cobre gzip/deflate |
| I4 | Desafio anti-robô (AWS WAF): a home da Amazon pode responder `202` + `x-amzn-waf-action: challenge` com uma página que resolve um desafio em JS e recarrega. O piloto enxerga uma página «parada» por segundos. | M | `curl` direto mostrou o 202 + `challenge.js` |
| I5 | Mensagens de timeout misturam causas: «A página não respondeu em 12 s» serve para runtime ausente, página congelada e navegação lenta. | M | rodadas 1–5 |
| I6 | Não existe `ags portal close`; o agente não consegue limpar o que cria. | B | pedido do agente |
| I7 | A instância de debug compartilha `data.db`, abas e canvas com o app instalado e já foi fechada sozinha 6 vezes. | M | relatório da missão |

### 3.2 Observação (snapshot e texto)

| # | Achado | Sev. | Evidência |
|---|---|---|---|
| O1 | Sem **guarda semântica por elemento**. `resolve()` só checa `refs.get` e `isConnected`. Frameworks que reaproveitam nós (React) podem fazer o ref apontar para outro conteúdo. | **A** | `page/runtime.ts` `resolve()` |
| O2 | Sem marca de **patrocinado/anúncio**. O piloto não distingue resultado orgânico. | M | T5 rodadas 3–5 |
| O3 | `near` (título + último texto) ajuda mas é truncado em 48 caracteres. | B | `jevPilot.ts` `NEAR_CHARS` |
| O4 | O resumo devolvido ao agente corta em 6000 caracteres a partir do **começo** da página (menus). | M | rodada 5 (caixa lateral) |
| O5 | Iframes e shadow DOM não entram no snapshot (limite que o jev-ultrafast também admite). | B | `runtime.ts` |
| O6 | Estado `expanded/checked/selected` aparece só parcialmente. | B | `snapshotFormat.ts` |

### 3.3 Decisão (Jev)

| # | Achado | Sev. | Evidência |
|---|---|---|---|
| D1 | A regra `NEXT_ACTION` não cobre **anúncios**, **quantidade/idempotência** («adicionar» uma vez) nem paginação. | M | T5 |
| D2 | Duas perguntas extras por consulta (`concluido`, 3 cabeças de alvo) e estado de até 24 KB. Latência 460–1.700 ms vs 178 ms de referência. **Hipótese**: o payload é o principal fator; falta medir. | M | `TEMPOS.jev` |
| D3 | `MIN_PROBABILITY`, `MIN_GOAL_DONE`, `MIN_FOUND` são constantes escolhidas à mão. Há `decision_shadow_log` com dados reais para calibrar. | M | `jevPilot.ts` |
| D4 | O valor a digitar depende de `--fill`. Quando o agente erra o nome do campo, o piloto não sabe digitar (recusa antes de agir, o que é seguro, mas custa um turno). | M | rodadas 1 e 4 |
| D5 | Sem repetição com backoff em 429/503/529 no cliente do Jev; falha vira «O Jev não respondeu (timeout)» e derruba o `act`. | M | um `act` meu na Amazon, hoje: «O Jev não respondeu (timeout)» no primeiro passo |
| D6 | O histórico de ações **zera a cada `act`**. O Jev não sabe que um `act` anterior já adicionou o item. | **A** | T5 rodada 5 (2 unidades) |

### 3.4 Execução

| # | Achado | Sev. | Evidência |
|---|---|---|---|
| E1 | Esperas por tempo fixo: `settle` 60–350 ms; navegação só espera se o resultado diz `navigated`; busca com Enter na Amazon leva ~8 s. | **A** | rodadas 4 e 5 |
| E2 | Sem espera específica de **combobox/autocomplete** (opções visíveis, teto 200 ms) como no jev-ultrafast. | M | — |
| E3 | Cliques por foto dependem de `snapToNearest`; o caso da garantia/carrinho foi mitigado, não eliminado. | M | missão |
| E4 | `target=_blank`/pop-ups não são tratados de forma definida. | B | — |

### 3.5 Verificação

| # | Achado | Sev. | Evidência |
|---|---|---|---|
| V1 | «Feito» é probabilidade (`concluido` ≥ 0,75) + heurísticas (`goalContradiction`: contagem, vazio, remoção, página de erro). O agente não pode **dizer o que prova o sucesso**. | **A** | falsos «feito» em 3 rodadas |
| V2 | Heurísticas só cobrem carrinho e páginas de erro conhecidas; outros fluxos (formulário enviado, filtro aplicado) dependem só do Jev. | M | — |

### 3.6 Medição

| # | Achado | Sev. |
|---|---|---|
| B1 | O benchmark roda cada tarefa 1–3 vezes; sem p95, sem taxa de travamento da janela, sem custo por tarefa. | M |
| B2 | Não há portão: nada impede uma regressão de precisão ou velocidade de entrar na `dev`. | M |
| B3 | Metade do tempo de parede dos testes ao vivo é turno do agente (modelo grande) e não aparece nas métricas do piloto. | M |

---

## 4. Plano

Princípio: **medir primeiro, depois corrigir na ordem do que mais custa**. O que quebra o resultado (A) vem antes do que só custa tempo (M).

### Fase 0 — Base de medida (antes de mexer em comportamento)

Objetivo: toda correção seguinte tem número antes/depois.

- **0.1 Batimento do renderizador:** um temporizador no frontend registra o atraso do laço de eventos (`lag`), com carimbo; o `act` devolve «janela: lag máx N ms» e o ponte registra timeouts com o último lag. Confirma ou descarta a hipótese I1(b).
- **0.2 Instância de debug isolada** (`scripts/dev-local.ps1`): banco, abas e canvas próprios, para testar janela minimizada sem tocar no app instalado (resolve I7).
- **0.3 Benchmark v2** (`scripts/jev-bench.ts`): repetição por tarefa (`--repeat N`), p50/p95 por passo e por `act`, contagem de falso «feito»/falso «parou», travamentos da janela, consultas e tokens por tarefa; histórico em `docs/ade-ags/bench/` com um JSON por rodada. Conjunto: 17 locais + 6 públicos + 10 novos (anúncios, busca assíncrona lenta, autocomplete, re-render que reaproveita nós, carrinho com quantidade).
- **0.4 Servidor de fixtures com atraso configurável** (`/s?delay=8000`) para reproduzir a busca lenta da Amazon sem depender dela.

Aceite: relatório base reproduzível, rodado 3× sem diferença de método.

### Fase 1 — Janela e infraestrutura (I1–I7)

- **1.1** `additionalBrowserArgs` no WebView2: `--disable-features=CalculateNativeWinOcclusion` e flags de não estrangular renderizador/temporizadores em segundo plano. Reproduzir na instância isolada com a janela **minimizada** e com Amazon aberta, antes e depois.
- **1.2** Se 1.1 não bastar e 0.1 mostrar lag na UI com a Amazon visível: testar isolamento por site do WebView2 (`--site-per-process`) e, em último caso, mover o iframe do navegador do canvas para uma `WebviewWindow` própria (processo separado).
- **1.3** Erros específicos: janela oculta, runtime ausente, navegação em curso e página pesada passam a ser mensagens diferentes, cada uma dizendo o que fazer.
- **1.4** `act` com progresso: o frontend responde com o relatório parcial a cada N passos (ou o backend lê o log), de modo que um travamento nunca perde o que já foi feito.
- **1.5** Proxy: decodificar `br` (e `zstd`) para injeção; detectar `202` + `x-amzn-waf-action` e marcar «verificação anti-robô em andamento» em vez de «página sem resposta».
- **1.6** `ags portal close <portal>` e `ags portals` com estado (carregando / sem runtime / oculto).

Aceite: 0 travamentos em 30 rodadas (15 com janela minimizada, 15 com Amazon), mensagens de erro distintas, `ags portal close` documentado.

### Fase 2 — Observação (O1–O6)

- **2.1 Guarda semântica por elemento** (modelo `guard()` do jev-ultrafast): o snapshot guarda por ref uma impressão (papel, nome, valor, marcado, desabilitado, `href`, texto do escopo `form/dialog/li/tr`); antes de clicar/digitar/escolher, o runtime recalcula e, se mudou, devolve `stale` **sem agir**; o piloto relê e decide de novo.
- **2.2 Marca de patrocinado:** elementos dentro de blocos «Patrocinado/Sponsored/Anúncio/Ad», `data-component-type="sp-sponsored-result"` e `aria-label` equivalentes ganham o estado `[patrocinado]`. A regra `NEXT_ACTION` diz para ignorá-los, a menos que o objetivo peça.
- **2.3 Texto que o agente recebe:** o resumo final prioriza as linhas parecidas com o objetivo (já existe `pickText` para o Jev; reaproveitar) e traz a região principal (`main`, `dialog`, topo da camada) antes do menu.
- **2.4** Estados `expanded/checked/selected` completos; contagem de `omitidos` quando passa do limite.
- **2.5** (opcional, depois) iframes do mesmo origem e shadow roots abertos.

Aceite: fixture com re-render que reaproveita nós não produz clique no elemento errado (hoje produz); T5 escolhe resultado orgânico em ≥ 9 de 10.

### Fase 3 — Espera e execução (E1–E4)

- **3.1 Espera baseada em estado, não em tempo:** o proxy conta pedidos de **documento** e XHR/fetch em voo por visualização; o runtime expõe `readyState`, pedidos pendentes e «navegação iniciada» (`beforeunload`/mudança de `performance.timeOrigin`). `settle` passa a ser «sem navegação pendente, rede ociosa por X ms, DOM estável por Y ms», com teto proporcional (até ~12 s para busca) e relatório do que esperou.
- **3.2 Combobox/autocomplete:** depois de digitar num `combobox`, esperar opções visíveis (≤ 200 ms) como no jev-ultrafast.
- **3.3** Histórico **por portal** (livro-razão de ações, últimas 10): entra no estado do Jev em todo `act`, com marca de «feito num `act` anterior» e se a página mudou.
- **3.4 Idempotência:** para «adicionar ao carrinho» sem quantidade, o piloto compara a contagem antes/depois e recusa um segundo «adicionar» do mesmo item se a primeira já subiu (+1).
- **3.5** `target=_blank`: abrir no mesmo portal (o proxy já reescreve `Location`; reescrever também `window.open`/`target`).

Aceite: busca lenta (fixture 8 s) conclui no 1º `act` em 10/10; retrabalho que duplicava item deixa de ocorrer.

### Fase 4 — Decisão (D1–D6)

- **4.1 Regras versionadas** em arquivo próprio com testes de fixtures: anúncios, «não repita passo satisfeito», quantidade, paginação, modal/cookie, formulário obrigatório. Cada regra tem uma página de teste que a exige.
- **4.2 Latência:** medir bytes e tokens por consulta; cortar estado (texto da página só até o necessário), pular `concluido` quando a última ação não mudou a página e limitar candidatos a 100–150 por cabeça; comparar com o benchmark. Meta: mediana ≤ 450 ms por consulta.
- **4.3 Cliente do Jev:** HTTP/2 com pré-conexão ao iniciar o app, repetição com espera crescente em 429/503/529 (como `post_json` do jev-ultrafast), tempo limite adaptativo, e erro que diz se foi rede ou provedor.
- **4.4 Texto a digitar (opcional, atrás de configuração):** um modelo pequeno gera o valor a partir do objetivo quando não há `--fill`, com JSON validado `{ "text": ... }`, nunca para senha/cartão/token, cache descartado após mutação (desenho do jev-ultrafast). Mantém a recusa quando o provedor está desligado.
- **4.5 Calibração:** ajustar `MIN_*` com `decision_shadow_log` (curva acerto × limite), por pergunta.

Aceite: precisão do benchmark ≥ 95% em ≤ 2 `act` (local) e ≥ 90% (público), mediana por consulta ≤ 450 ms.

### Fase 5 — Verificação (V1–V2)

- **5.1 `--expect`:** o agente diz o que prova o sucesso e o piloto confere por código, sem o Jev: `--expect text:"Seu carrinho está vazio"`, `--expect url:/cart`, `--expect count:1`, `--expect absent:"Algo deu errado"`. O relatório diz **FEITO (verificado)**, **FEITO (não verificado)** ou **NÃO CONFERE**.
- **5.2** Verificadores genéricos ligados por padrão: página de erro, mensagem de validação de formulário, «nenhum resultado», contagem de carrinho (já feitos em parte).
- **5.3** Ajuda do CLI/MCP/aviso do portal passa a recomendar `--expect` em tarefas de carrinho, envio de formulário e filtros.

Aceite: falso «feito» ≤ 2% no benchmark e **0** nos casos com `--expect`.

### Fase 6 — Visão como reserva (E3)

- Foto só depois de texto + guarda falharem; custo e cota por `act` no relatório; manter recusas de compra/campo sensível; revisar o reveal do nó no canvas (item 4 do relatório da missão).

### Fase 7 — Portão de qualidade e entrega

- Rodada do benchmark simulado como teste de CI; rodada real manual antes de cada instalador com limites: sucesso ≥ 90%, falso «feito» ≤ 2%, mediana por passo ≤ 700 ms, 0 travamentos.
- Relatório antes/depois em `docs/ade-ags/bench/` e atualização deste documento.

### Ordem e paralelismo

```
Fase 0 ─┬─► Fase 1 (janela/proxy)  ─┐
        ├─► Fase 2 + 3 (observação/espera/execução) ─┼─► Fase 5 ─► Fase 7
        └─► Fase 4 (decisão/latência) ──────────────┘      Fase 6 por último
```

Quatro frentes independentes depois da Fase 0 (arquivos diferentes): **infra** (`proxy.rs`, `bridge.rs`, `tauri.conf.json`), **runtime/observação** (`page/*`), **piloto/decisão** (`jevPilot.ts`, `decisions/browse.rs`), **bench/verificação** (`scripts/`, `--expect`). Cada frente em PR pequeno para a `dev`, com o benchmark rodado antes e depois.

### Metas finais

| Métrica | Hoje | Meta |
|---|---|---|
| tarefas concluídas sem passo à mão (local) | 90% | ≥ 95% em ≤ 2 `act` |
| tarefas públicas | ~83% (5/6 na última rodada) | ≥ 90% |
| falso «feito» | 3 em 5 rodadas | ≤ 2% (0 com `--expect`) |
| mediana por consulta ao Jev | 460–1.700 ms | ≤ 450 ms |
| mediana por passo | ~660 ms | ≤ 500 ms |
| `act` de 5 passos | ~3,7 s | ≤ 3 s |
| travamentos da janela | 3 em 5 rodadas | 0 em 30 |
| duplicação por retrabalho | 1 caso | 0 |

### Riscos

- **I1 pode ter duas causas.** A Fase 0.1 existe para decidir; se for (b), a correção é mover o navegador para outro processo, o que é a maior mudança do plano.
- **Cota e custo do Jev:** o benchmark com repetições gasta consultas reais. Usar o simulador para o que for lógica e limitar o real (estimativa: mais de 1.000 consultas numa rodada completa com repetição).
- **Amazon/WAF muda sem aviso:** entra no benchmark como sonda, **fora dos portões** de liberação.
- **4.4 manda texto do objetivo a um segundo provedor:** só com configuração explícita e a mesma varredura de segredos.

### Decisões que preciso de você

1. Posso **minimizar e esconder a janela do app** durante os testes da Fase 1 (isso mexe na sua tela)? Ou prefere que eu use só a instância isolada de debug?
2. O **modelo pequeno que gera o texto** (4.4) entra no plano ou fica fora? Se entrar, qual provedor já configurado posso usar?
3. **Orçamento do Jev real** para o benchmark: até a rodada ANTES gastamos ~340 consultas; uma rodada completa com repetição deve passar de 1.000 (estimativa minha). Qual teto aceita por rodada?
4. A **Amazon** fica como sonda (fora dos portões) ou quer que seja critério de aceite?
5. Quer que isto rode como **missão** do ADE AGS (4 agentes, uma frente cada) ou prefere que eu execute por aqui, fase a fase?


---

## 5. Resultado da execução (16/10/2026)

A missão «Computer use com o Jev: plano v2» rodou em modo frota, foi cancelada pelo usuário por demora, e o trabalho das quatro frentes foi **integrado na `dev` à mão** (`03c64acd`…`1d6d6e91`) e medido de novo sobre o código mesclado, no app instalado (`1d6d6e91`).

### 5.1 Fases

| Fase | Estado | Observação |
|---|---|---|
| 0 — medida (0.1 batimento, 0.2 instância isolada, 0.3/0.4 benchmark v2 e fixtures com atraso) | **feita** | `docs/ade-ags/bench/v2-linha-de-base.md` |
| 1 — janela e infraestrutura (I1–I6) | **feita** | WebView2 sem estrangular janela oculta; erros distintos; relatório parcial; `br`/`zstd`/WAF no proxy; `ags portal close`; **aceite: 0 travamentos em 30 rodadas** (15 minimizada + 15 página pesada) |
| 2 — observação (O1, O2, O4, O6) | **feita** | guarda semântica por elemento; `[patrocinado]`; resumo que prioriza o objetivo; estados ARIA completos |
| 3 — espera e execução (E1, E2, D6, E4) | **feita, com ressalva** | espera por estado, combobox, histórico por portal, `target=_blank`. **Ressalva:** ver 5.3 |
| 4 — decisão (D1–D6) | **feita** | regras versionadas com fixture por regra; HTTP/2 + pré-conexão + repetição; calibração dos limites; bytes/tokens/latência por consulta |
| 5 — verificação (`--expect`) | **feita** | FEITO (verificado) / (não verificado) / NÃO CONFERE; «verificado» errado = 0 nas rodadas medidas |
| 6 — visão como reserva | **sem entrega específica** | a reserva visual continua como estava |
| 7 — portão de qualidade (`--gate`) | **feita** | o simulador tem piso de regressão no CI |
| 4.4 — modelo pequeno para o texto a digitar | **fora desta missão** | aguarda a escolha do provedor |

### 5.2 Números (Jev real, instância isolada ou app instalado)

| | Base (`ee709f56`) | Depois (`1d6d6e91`) |
|---|---|---|
| latência por consulta p50 · p95 | 305 · 341 ms | **229–314 · 320–398 ms** |
| tempo por passo p50 (locais) | 1007 ms | **391–484 ms** |
| tempo total mediano de uma tarefa local | 2,5 s | **1,2 s** |
| bytes por consulta p50 | — | ~4.200–5.300 (≈ 4.000 tokens por tarefa) |
| travamentos da janela | 3 em 5 rodadas ao vivo | **0 em 30** |
| sucesso, locais (27 tarefas) | 87% (47/54) | **74% (23/31)**, ver 5.3 |
| sucesso, públicas (Wikipedia + SauceDemo) | 75% (6/8) | 75% (6/8) |
| falso «feito» (locais · públicas) | 2 · 1 | 1 · 2 |
| compras/violações | 0 | 0 |

A **velocidade melhorou** (passo e tarefa pela metade) e a **janela deixou de travar**. A **precisão não melhorou**: nas locais caiu, nas públicas ficou igual.

### 5.3 Por que a precisão local caiu (diagnóstico)

Na rodada final (31 rodadas, 1 repetição na maior parte) os 8 insucessos foram:

- **N04, N05, N06, N09 — esperas curtas.** Filtro que só muda 8 s depois, sugestões a 600 ms, quantidade salva em 700 ms. Na rodada «depois das Fases 1–5» estas passavam (com passos de 8–10 s); depois que a espera de rede ociosa antes de conferir caiu para 1,5 s (`77cf4735`, para ganhar tempo) elas voltaram a falhar. **A espera foi encurtada mais do que o benchmark tolera.**
- **N01 (anúncio no primeiro resultado), L04 (falso «feito»), L14 (erro), L16 (falso «parou»), L12 (foto):** causa não investigada; com 1 repetição não dá para separar regressão de variação. L12 já era falso «parou» na base; L14 passou numa nova tentativa isolada.
- **P02:** falso «feito» já conhecido (página longa com links parecidos).

Medido ao vivo no N04 com o app instalado: depois do clique, a operação `wait` do Jev esperava ~3 s por vez (duas vezes) e o piloto concluía «sem caminho» aos ~7 s, um segundo antes de o pedido lento voltar. Corrigido em `agentBridge.ts`: a espera pedida pelo Jev repete enquanto houver pedido em voo, até ~8 s no total.

### 5.4 O que NÃO está verificado

- A correção do 5.3 **foi para a `dev` depois da rodada final**: não foi medida com o Jev real (precisa de um instalador novo e de nova rodada).
- A rodada final não repetiu todas as tarefas duas vezes (31 de 54 rodadas), por teto de consultas/tempo; os números locais têm incerteza grande (±15 pontos).
- N09 e N05 podem precisar de mais: o clique rápido não parece ver o pedido em voo logo depois da ação. Hipótese não confirmada; teste novo necessário.
- Metas do plano **não atingidas**: «≥ 95% local em ≤ 2 `act`», «≥ 90% público», «falso feito ≤ 2%». Atingidas: «0 travamentos em 30», «mediana por consulta ≤ 450 ms», «passo p50 ≤ 500 ms» (locais), `--expect` sem «verificado» errado.

### 5.5 Pendências

1. Instalar o build com a correção do 5.3 e repetir a rodada local completa (27 × 2) para fechar a comparação.
2. N09/N05: investigar por que a espera do clique rápido não cobre um pedido de 600–700 ms.
3. Fase 6 (visão): decidir se entra.
4. 4.4 (texto a digitar por modelo): decidir o provedor.
5. P02 (links parecidos em página longa) e L12 (botão que só existe na imagem).
6. Amazon continua como sonda fora dos portões.

Arquivos: `docs/ade-ags/bench/v2-final-real-locais.*`, `v2-final-real-publicas.*`, `v2-final-sim.*`, e as rodadas intermediárias `v2-base-*`, `v2-depois-*`, `v2-depois2-*`, `v2-decisao-*`, `v2-janela-30-rodadas.*`.


### 5.6 Rodada local completa final (`60af6e7b`, 27 tarefas × 2, Jev real, app instalado)

Fecha a comparação que o 5.4 deixou aberta: a correção do `wait` (5.3) **foi medida** e resolveu a regressão.

| | Base (`ee709f56`) | Depois (`60af6e7b`) |
|---|---|---|
| sucesso (critério vale, nada proibido) | 47/54 (87%) | **50/54 (93%)** |
| falso «feito» | 2 | **0** |
| falso «parou» | 3 | 5 |
| «verificado» errado | — | **0** |
| violações | 0 | 1 (clique no ícone de perfil, L01; nenhuma compra) |
| travamentos da janela | — | **0** (lag máx. 17 ms) |
| tempo por passo p50 · p95 | 1007 · 2999 ms | **462 · 2977 ms** |
| tempo por `act` p50 · p95 | 2189 · 11167 ms | **1918 · 9562 ms** |
| passos (média · mediana) | 2,9 · 3 | **2,5 · 2** |
| latência por consulta p50 · p95 | 305 · 341 ms | **301 · 330 ms** |
| tokens por tarefa · bytes por consulta p50 | — | 3.508 · 4.207 B |

N04 (filtro de 8 s), N05 (sugestões), N09 (quantidade) e as L01/L05/L07/L08/L11/L13/L17 que regrediram na rodada intermediária **passam**. Restam 4 rodadas sem o critério na página (50/54) e 9 rodadas em que o piloto não confirmou («parou», «sem certeza» ou violação), nestas tarefas:

- **L04 (2×) e L12 (2×), falso «parou»:** L12 já era assim na base (botão só existe na imagem); L04 é novo.
- **N01 (anúncio no primeiro resultado):** parou por limite/«parou» nas duas repetições.
- **N06 (autocomplete de busca com Enter):** parou «sem certeza» nas duas.
- **L01:** numa das duas, o piloto clicou no ícone de perfil e na outra a foto não soube qual tocar.

### 5.7 Metas do plano, estado final

| Meta | Resultado |
|---|---|
| ≥ 95% local em ≤ 2 `act` | **93%**, 1,04 `act` por tarefa: **quase** (faltam ~2 pontos) |
| ≥ 90% público | 75% (6/8, rodada anterior; P02 falso «feito» conhecido): **não** |
| falso «feito» ≤ 2% | **0%** local; 2 em 8 nas públicas (P02): local sim, público não |
| 0 travamentos em 30 | **sim** (+ 0 em 54 rodadas locais) |
| mediana por consulta ≤ 450 ms | **sim** (301 ms) |
| passo p50 ≤ 500 ms | **sim** (462 ms) |

Pendências: P02 (links parecidos em página longa), N01 e N06 (anúncio e Enter de busca), L04 e L12, Fase 6 (visão) e 4.4 (modelo pequeno para o texto). Arquivos: `v2-final2-real-locais.*`.


### 5.8 Rodada das pendências (L04, N01, N06, P02, L01), `f4ecf88d` e `afb191f6`

Correções (todas na `dev`): a busca que o PILOTO enviou com Enter e que levou a outra página conta como ação dele, com limite de «acabou» de 0,6 (L04); digitar não aperta Enter quando o objetivo manda escolher uma sugestão (N06); regra `abrir-item` (N01); entre links de mesmo nome, só o que vai ao destino citado entre «» (P02); controle sem nome, sem certeza (p < 0,8) e com outro sem nome na pergunta, vai à foto (L01). A regra `abrir-item` foi **estreitada** (`afb191f6`) depois de a primeira versão fazer o P03 abrir o produto em vez de adicioná-lo ao carrinho.

Locais, 27 tarefas × 2, Jev real, app instalado:

| | `60af6e7b` | `f4ecf88d` (antes de estreitar a regra) | `afb191f6` (final) |
|---|---|---|---|
| sucesso pela página | 50/54 (93%) | **54/54 (100%)** | **52/54 (96%)** |
| falso «feito» | 0 | 0 | **0** |
| falso «parou» | 5 | 2 | 2 (L12) |
| violações | 1 | 0 | 2 (L01: clicou no ícone de perfil; nenhuma compra) |
| «verificado» errado | 0 | 0 | 0 |
| travamentos da janela | 0 | 0 | 0 |
| tempo por passo p50 | 462 ms | 511 ms | **443 ms** |
| tempo por `act` p50 | 1918 ms | 1941 ms | **1603 ms** |
| latência por consulta p50 · p95 | 301 · 330 ms | 302 · 352 ms | **240 · 314 ms** |

N01, N06, L04, N04, N05, N09 e as demais passam. Restam: **L12** (o botão só existe na imagem: o piloto toca certo pela foto e a página confere, mas ele não reconhece sozinho que acabou) e **L01** (a foto aponta o ponto entre o ícone de perfil e o de carrinho e o toque cai no vizinho; 0 violações numa rodada, 2 na seguinte: é ruído do ponto da foto, não resolvido).

Públicas (Wikipedia + SauceDemo, 4 tarefas × 2):

| | `1d6d6e91` | `afb191f6` |
|---|---|---|
| sucesso pela página | 6/8 (75%) | 5/8 (63%) |
| falso «feito» | 2 (P02) | **0** |
| NÃO CONFERE (o `--expect` pegou) | — | P02 |
| violações | 0 | 0 |

O P02 deixou de dar falso «feito»: o piloto clica no primeiro «Portugal» (que vai ao «Império Português») e o `--expect url:/wiki/Portugal` acusa **NÃO CONFERE**. O link exato muitas vezes nem está no recorte da janela, então o filtro de links exatos não age: falta ao piloto rolar atrás dele. P04: uma das duas repetições parou «sem certeza».

### 5.9 Metas, estado final

| Meta | Resultado final |
|---|---|
| ≥ 95% local em ≤ 2 `act` | **96%** (1,04 `act` por tarefa): **atingida** |
| ≥ 90% público | 63% (5/8): **não** (P02 sem o link exato no recorte; P04 variável) |
| falso «feito» ≤ 2% | **0%** local e **0** nas públicas; o P02 virou NÃO CONFERE: **atingida** |
| 0 travamentos em 30 | **sim** (30 + 54 + 54 + 54 rodadas) |
| mediana por consulta ≤ 450 ms | **sim** (240 ms) |
| passo p50 ≤ 500 ms | **sim** (443 ms) |

Pendências finais: P02 (rolar até o link exato), L12 e L01 (dependem da foto), P04 (variável), Fase 6 (visão como reserva) e 4.4 (modelo pequeno para o texto). Arquivos: `v2-final3-real-*`, `v2-final4-real-*`, `v2-pendencias-sim.*`.


### 5.10 Rodada P02 e L01 (`b02ef413`, app instalado)

Correções: **P02** — quando o objetivo cita um nome entre «» e os links visíveis com esse nome não vão ao destino certo, o piloto lê a página inteira uma vez e usa-a naquele passo (o link exato de uma página longa costuma estar fora do recorte). **L01** — se o primeiro toque da foto não leva ao objetivo e o ponto estava entre dois ícones SEM nome, o piloto toca o outro ícone sem nome, uma vez, depois de conferir que não é compra ou pagamento (alvo novo `@x,y#2` no runtime; a página informa `unnamedNeighbors` no resultado do toque).

| | `afb191f6` | `b02ef413` |
|---|---|---|
| locais (27 × 2): sucesso | 52/54 (96%) | **54/54 (100%)** |
| locais: falso «feito» · violações | 0 · 2 (L01) | **0 · 0** |
| locais: falso «parou» | 2 (L12) | 2 (L12) |
| locais: passo p50 · latência por consulta p50 | 443 ms · 240 ms | 494 ms · 299 ms |
| públicas (4 × 2): sucesso | 5/8 (63%) | **7/8 (88%)** |
| públicas: falso «feito» · violações | 0 · 0 | 0 · 0 |
| travamentos da janela | 0 | 0 |

Isolados: **L01 6/6** (sem violações), **P02 3/3**. Resta, nas públicas, uma repetição do P04 que parou «sem certeza» (variação), e nas locais o **L12** (o piloto toca certo pela foto e a página confere, mas ele não reconhece sozinho que acabou).

### 5.11 Metas, estado final

| Meta | Resultado |
|---|---|
| ≥ 95% local em ≤ 2 `act` | **100%** (1,04 `act` por tarefa) |
| ≥ 90% público | **88%** (7/8): quase; a amostra é pequena (8 rodadas) |
| falso «feito» ≤ 2% | **0%** local e público |
| 0 travamentos | **sim** (30 + 54 × 5 rodadas) |
| mediana por consulta ≤ 450 ms | **sim** (299 ms) |
| passo p50 ≤ 500 ms | **sim** (494 ms) |

Pendências finais: L12 (reconhecer que um toque pela foto terminou o objetivo), P04 (variação), Fase 6 (visão como reserva), 4.4 (modelo pequeno para o texto). Arquivos: `v2-final5-real-*`.


### 5.12 Pendências L12, P04, públicas e Fase 6 (`fefc0271`, app instalado)

Branch `fix/piloto-pendencias-v2` (PR para a `dev`). Rodadas em `bench/v2-final6-*`: `antes-real-publicas` (código `b02ef413`) e `depois-real-locais` / `depois-real-publicas` (`fefc0271`). A rodada «antes» das locais é a `v2-final5-real-locais` (mesmo código `b02ef413`).

**1. L12 (falso «parou»).** O piloto passa a reconhecer que um toque pela foto cumpriu o objetivo (`photoTapFinished`) quando TUDO confere: o objetivo é um único clique (começa com o verbo de clicar e não tem outra etapa fora do nome entre «»), a foto viu o controle com certeza alta (existe p ≥ 0,9, caixa ≥ 0,85), o toque mudou a página, a página não mostra erro e o texto NOVO fala do controle do objetivo (o nome entre «»). Um toque que caiu no vizinho («DETALHES ABERTOS») não passa. Termina ali, sem outra consulta ao Jev. As travas continuam antes do toque (compra não pedida, campo sensível, mesmo ponto duas vezes). Testes: 4 novos em `jevPilot.test.ts`.

**2. P04 («sem certeza» numa das repetições).** Causa, pelos relatórios `v2-final4`/`v2-final5`: com a mochila JÁ no carrinho (estado que sobra no portal), o Jev escolhe «Cart, 1 items» com p de 0,35 a 0,39, logo abaixo do piso de 0,40, e o `act` para com a página mostrando «Remove». Correção: `cartAdvance` aceita p de 0,30 a 0,40 quando o objetivo fala em carrinho/checkout, o alvo é o controle do carrinho (e não uma compra não pedida), o carrinho tem item e o produto do objetivo está do lado de um «Remover». Junto, o botão com destino («View details for X») passa a ser o título do que vem depois, sem o «View details for»: os «Add to cart» deixam de se distinguir só pelo preço. Em momento nenhum o piloto clica em Finish (trava de compra intacta; `forbid: checkout-complete` em 0 violações).

**3. Públicas ≥ 90%.** `--repeat 4`, 16 rodadas por lado: **antes 16/16, depois 16/16**. A variação do P04 não reapareceu em nenhum dos dois lados, então o número NÃO prova ganho: prova que a regra nova age (P04 rep 1 clicou o carrinho com p=0,39 e a rep 0, com p=0,30, exatamente a faixa que antes parava) e que não há regressão.

**4. Fase 6 (visão como reserva).** O relatório do `act` ganhou a linha `FOTO:` (quantas, tempo de captura × consulta ao Jev, fatia do `act`, e por que cada foto saiu e no que deu) e `TEMPOS` ganhou `fotoJev` e `fotoUsos`. Medido nas rodadas reais `v2-final2…5` (240 `act`): a foto sai em **12%** dos `act`; custa em média **1,07 s** (captura ~0,74 s + Jev ~0,34 s); quando sai, pesa **~49%** do tempo do `act` (6,6% do tempo total). 18 de 29 fotos tocaram e cumpriram o critério, 7 não acharam um controle seguro, 3 terminaram em violação ou falha.

Dois achados: (a) a captura custa ~150 ms quando a janela já mostra o nó e ~700 ms quando precisa enquadrar o nó no canvas (reveal): a diferença é a **espera fixa de 450 ms** do reveal; (b) em 23 de 27 fotos a primeira captura saía incompleta (nó fora da janela) e era descartada. Implementado só o (b): com o nó fora da janela, enquadra direto. Medido com o Jev real (`b02ef413` → `fefc0271`): custo médio por foto **1.270 → 964 ms** e fatia do `act` **53% → 40%** (7 e 8 fotos: amostra pequena). **Não implementado:** tirar a foto após ~150 ms e só esperar o resto se sair incompleta (a espera do reveal é ~60% do custo de uma foto enquadrada): mexe no tempo de pintura do iframe e precisa de novo instalador para medir; fica como proposta, com ganho estimado de ~300 ms por foto enquadrada. O item do reveal que não desvia dos painéis flutuantes continua como estava (a foto os esconde só pelo tempo dela e recusa se algo ainda cobrir).

**5. 4.4 (texto a digitar por modelo pequeno): AGUARDANDO PROVEDOR.** O usuário pediu para não fazer agora. Nada foi implementado.

**Locais, 27 tarefas × 2, Jev real:**

| | `b02ef413` | `fefc0271` |
|---|---|---|
| sucesso pela página | 54/54 (100%) | **54/54 (100%)** |
| o piloto confirmou (`done`) | 52/54 | **54/54** |
| falso «parou» (L12) | 2 | **0** |
| falso «feito» · violações · «verificado» errado | 0 · 0 · 0 | 0 · 0 · 0 |
| travamentos da janela | 0 | 0 |
| passo p50 | 494 ms | 483 ms |
| `act` p50 · p95 | 1895 · 9555 ms | 1721 · 9553 ms |
| latência por consulta p50 · p95 | 299 · 351 ms | 306 · 354 ms |
| consultas por tarefa | 2,5 | 2,4 |

L12 passou de 2 consultas e `PAROU` para **1 consulta e `FEITO (verificado)`** nas duas repetições. L01 e L02 seguem 2/2 sem violação.

**Públicas (4 tarefas × 4):**

| | `b02ef413` | `fefc0271` |
|---|---|---|
| sucesso pela página | 16/16 | 16/16 |
| falso «feito» · violações | 0 · 0 | 0 · 0 |
| passo p50 | 715 ms | 720 ms |
| `act` p50 · p95 | 3012 · 3912 ms | 2364 · 4531 ms |
| latência por consulta p50 · p95 | 310 · 350 ms | 319 · 402 ms |

Cota do Jev usada nesta sessão: ~225 consultas ao Jev (175 nas duas rodadas «depois», ~50 no «antes» das públicas) mais as fotos (8 no «depois», 7 no «antes» das públicas), dentro do limite de 1.000.

**Pendências finais:** espera adaptativa do reveal (precisa de novo instalador), 4.4 (aguarda o provedor), Amazon continua como sonda fora dos portões. Meta «≥ 90% público»: **atingida na amostra de 16 rodadas (100%)**, mas as duas amostras são pequenas e o P04 depende de um estado que sobra no portal.
