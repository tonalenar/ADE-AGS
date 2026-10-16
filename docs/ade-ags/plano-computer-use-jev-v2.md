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
