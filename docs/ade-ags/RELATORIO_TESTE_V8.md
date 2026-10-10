# Relatório do teste completo v8 (squad E2E)

Versão instalada: ADE AGS 1.8.7, master `d655f72`. Missão `eb2159f6`. Nenhum código do produto foi alterado. A **janela real do app não foi aberta** por nenhum integrante: tudo que é interface foi conferido apenas por leitura de código.

## 1. VIGIA — ligado, com 1 cutucada indevida observada

O Vigia **estava ligado**: o Frontend relatou, depois da entrega, que recebeu um lembrete do Vigia. Esta seção corrige a leitura inicial, feita antes dessa informação, de que ele estaria desligado. Nenhuma linha "Vigia" apareceu no chat do Orquestrador e nenhum outro terminal recebeu cutucada.

Balanço:

| Item | Resultado |
|---|---|
| Mensagens do Vigia ao chat do Orquestrador | 0 |
| Cutucadas no terminal do Backend | 0 (até 10:23 BRT) |
| Cutucadas no terminal do QA | 0 (10:16–10:23, sempre Working) |
| Cutucadas no terminal do Frontend | 1, **depois** de ele já ter entregue o relatório e estar ocioso |
| Úteis / ruído | 0 / 1 (ruído leve, segundo o Frontend) |
| `[Pasted text #N]` empacado | 0 |
| Cutucou quem já tinha entregue | **SIM** (Frontend) |
| Cutucou agente em Working | não observado (Frontend, QA e Backend sempre Working antes das entregas) |
| Codex em Working com tela parada > 8 min | não testado |

**Achado (médio): o Vigia cutucou um integrante que já tinha reportado a tarefa.** Isso contraria a regra "ignora integrante que já reportou a tarefa". Reprodução: Frontend entregou o relatório final ao Orquestrador, ficou ocioso, e o lembrete chegou ao terminal dele em seguida. O texto e o horário exatos da mensagem não foram capturados (saiu da tela antes da leitura). Para confirmar, rodar de novo e anotar horário da entrega e da cutucada.

Limites: a regra de "uma cutucada por vez", a regra da missão já entregue e o aviso de 8 min do Codex não foram verificados. O QA afirmou que o botão estava "desligado na UI", mas ele não abre a interface e a informação é contradita pela cutucada no Frontend. Os zeros dos outros terminais podem ser só falta de motivo para cutucar: ninguém ficou parado.

## 2. Achados por gravidade

**Bloqueante:** nenhum. **Alto:** nenhum.

### Médio

**M0. Vigia cutucou integrante que já tinha entregue** (Frontend, depois do relatório final). Ver seção 1.

**M1. Mensagens de erro em espanhol no CLI (cliBridge, front-end).** Confirmado por leitura: `src/features/orchestrator/cliBridge.ts` tem 16 ocorrências. Exemplos: linha 78 "Falta --agent", 87 "Agente desconocido", 124/138 "Falta --tab", 128/140 "Esta ventana no tiene ninguna tab con id", 174 "Falta la carpeta del proyecto", 186 "Falta la pregunta", 236 "Faltan cwd, a o b", 257 "La tab .. no tiene una terminal abierta", 326 "Falta el mensaje", 352 "El frontend no sabe atender". O commit `1297ae6` traduziu só o Rust. Repro: rodar comando de tab/nota/portal sem a flag obrigatória ou com `--tab` inexistente. (Frontend leu o código e não executou os comandos.)

**M2. Erro em espanhol observado ao vivo:** `ags mission timings` sem `--mission` devolve `{"error":"Falta el argumento --mission"}`. `ags tab create --agent bash` sem `--cwd` devolve `{"error":"Falta --cwd"}` (QA).

**M3. Erros do navegador embutido em espanhol:** `src/features/browser/agentBridge.ts:227,228,263,365,434`, `pageChannel.ts:28,34`, `page/runtime.ts:1045,1053,1071`, `annotate/capture.ts:85`, `page/netCapture.ts:152`. Visíveis via `ags browser`.

**M4. Laya — 8 falsos positivos `segredo=sim`** em propostas de memória sem credencial. IDs do log 3,5,6,7,10,11,13,14. Chaves: routemodal-esc-foco-em-opcao, v6-backend-cli-context, ambiente-teste-agentes, laya-sombra-memoria-na-revisao, qa_peer_delivery_behavior, qa_smoke_results, qa_worktree_layout, laya-shadow-v7. Confirmado pelo Backend correlacionando SHA256 de `proposal_state` com `memory_entries`/`revisions` e lendo o conteúdo das 8 (benignas). São 8 de 13 respostas de `memory_approval`. Só modo sombra, sem efeito automático. Evidência pré-existente: não afirmar que foram geradas nesta missão.

**M5. Canvas: áreas de redimensionar sempre ativas (só código, não visto na tela).** `CanvasView.tsx:~719` + `App.css:786-794`: `NodeResizer isVisible` agora sempre, criando áreas invisíveis de 10/16 px nas bordas/cantos de todo terminal. Podem roubar clique/seleção na borda e sobrepor as portas de conexão. O próprio commit diz "visual e arrastar não conferidos".

### Baixo

- **B1. Mais erros do backend em espanhol/inglês** (reproduzidos pelo Backend):
  - `ags run result --task <inexistente>` → "falta quién pide (taskId o cwd)" (`src-tauri/src/runs/orchestration.rs:59`).
  - Mesmo com `--cwd .` → ". no está abierta en ningún workspace de ADE AGS: abrila en una tab…" (`orchestration.rs:61`).
  - Com cwd válido sem run → "todavía no hay ningún run lanzado… creá uno con run_plan" (`orchestration.rs:99`).
  - `ags mission finish …` → "Comando desconocido: mission.finish" (`ipc/commands/dispatch.rs:258`). Sem flags: "Argumento inesperado … Este comando solo toma flags" (`bin/cli.rs:793`).
  - "Task not found" em inglês (`runs/policy.rs:113`).
  - Controles em PT que passaram: `mission status` com ID inexistente; `mission start` com cwd inexistente ("a pasta … não existe").
- **B2. Textos truncados sem tooltip:** `FleetView.tsx:73,87-89,96-97`; `ContasSection.tsx:113,117`; `MemoryPanel.tsx:118-119`; `CanvasView.tsx:746`.
- **B3. Idioma fixo no toast de memória:** `memory/pendingNotice.ts:25-28` devolve "Lead"/"Agente" fixos em en/es e depende de regex sobre texto PT gerado pelo backend.
- **B4. Tela Decisões (`DecisionsSection.tsx`):** (a) modelo inválido gravado deixa `saved` diferente e acende "Salvar" ao abrir (não ocorre com Laya local/multilingual); (b) timeout vazio vira 0 e só é limitado ao salvar (50–30000); (c) status sem `role="status"`, erros de salvar não anunciados; (d) `exportCsv` via `<a download>` com blob pode falhar em silêncio no webview Tauri (não verificado).
- **B5. Painel de memória (`MemoryRail.tsx:74,102`):** `hidden @5xl:` some o painel e o balão de pendências em janela estreita, sem outro caminho. `pendingTotal` (MemoryRail:13) duplica `totalPending` (pendingNotice.ts:5).
- **B6. `agentAccent` (`agents/agentTile.ts:18-26`):** Codex `#a1a1a8` é quase igual ao padrão `#8e8e93`; agente selecionado perde o brilho do orquestrador.
- **B7. `accounts/problem.ts:5-28`:** chaves de mapeamento em espanhol nunca casam se o backend já fala PT (a confirmar no Rust).
- **B8. ADE_TAB_ID ausente em subprocessos do Codex** (`powershell -Command ags peers` sem exportar a variável). Provavelmente ligado ao isolamento do Codex no Windows já conhecido.
- **B9. `ags tab output` logo após abrir aba do Claude Code** pode devolver tail vazia na primeira leitura.
- **B10. Português não idiomático:** "Guardar" em `sharedMemory.secretWarn/saveAnyway` e `fleet.rollback.create`; 3 valores iguais ao ES (`orchestrator.tooltip.last`, `models.native`, `memorySearch.verify.never`).

## 3. Verificado sem problema

- **i18n:** en/es/pt-BR com as mesmas chaves; nenhuma chave crua; nenhum espanhol dentro de `pt-BR.json`.
- **Acessibilidade:** varredura de botões só-ícone sem `aria-label`/`title` em missões, squads, configurações, contas, memória, canvas e agentes: nenhum (3 falsos positivos). O balão de pendências tem `aria-label` com contagem e `aria-expanded`.
- **jev-latest:** `decisionsModel.ts` define JEV_MODELS `jev-latest|jev-preview|jev-1.13.0` (padrão `jev-latest`) e Laya `multilingual|english|typed-decisions`; troca de provedor coerente; aviso de privacidade só fora de localhost.
- **`peer tell --file`:** arquivo UTF-8 com BOM (EF-BB-BF) e UTF-16 (FF-FE) com aspas, acentos, `$HOME` e crase chegaram íntegros ao QA e ao Frontend. O Claude Code **não** mostrou "Removed 1 invisible character".
- **Reenvio:** reenviar o mesmo UTF-16 ao QA ocupado deu `sent:false, duplicate:true` (esperado). **O caso `sent:false, unconfirmed:true` não foi obtido ao vivo**, então o reenvio nesse caso não foi validado E2E. O teste de unidade de dedupe passou.
- **Casos de borda (QA):** abas Antigravity, Claude Code, Codex e Shell abriram sem tela em branco; aba Shell criada e fechada via CLI.
- **`mission finish`:** não existe comando CLI; a validação "Só se finaliza à mão uma missão em terminais que esteja rodando" (`missions/mod.rs:555/567`) não foi exercitada.

## 4. Testes e tempos

| Suíte | Resultado | Tempo | Base | Variação |
|---|---|---|---|---|
| `ags test smoke` (QA) | 9/9 passaram, 0 pulados, 0 falhas | — | — | — |
| `ags test run rust` | verde: 1366 passaram, 10 ignorados + CLI 41 | 134,3 s | ~130 s | +3,3% |
| `ags test run frontend` | verde: 200 arquivos, 1670 testes | 15,4 s | 18 s | −14,5% |
| `ags test run tsc` | verde | 35,6 s | 23 s | +54,8% |
| `ags test affected` | "Nada a testar: só arquivos sem efeito em código", `skippedAffected=4` | — | — | — |

- As três suítes rodaram com sobreposição de carga, então o aumento do tsc não prova regressão.
- A segunda execução das três deu `cacheHit=true`, "já verde neste hash"; `ags test status` mostra os três verdes.
- Não houve edição para provocar invalidação de cache.

## 5. Tempos da missão (`ags mission timings`)

- Até todos trabalhando: 41,9 s (partida do boot em 1791638150671 até `start_all_working`).
- Boots: 5 spans, total 39,9 s, máximo 12,8 s.
- Houve `start_retry` em Orquestrador, Backend e QA, e um `start_stalled` do QA no arranque. Ele se recuperou em ~12 s após o reenvio do Enter.
- Espera do Orquestrador: 0 ms. Espera do QA: 0 ms. Travamentos do Orquestrador: 0.
- Primeira delegação: 47 s após o início.

## 6. Laya (snapshot 2026-10-10 13:23:27 UTC, SQLite somente leitura)

Configuração: habilitada, laya_local, `http://localhost:8000`, modelo multilingual, timeout 2000 ms, quatro pontos ligados. Nada foi alterado nem salvo, e não houve escrita em `~/.ags/data.db`.

| Ponto | Linhas | Mín | Média | Mediana | p95 | Máx | Erros |
|---|---|---|---|---|---|---|---|
| memory_approval | 14 | 487 ms | 760,2 ms | 533,5 ms | 2013 ms | 2013 ms | 1 timeout |
| mission_gate | 3 | 390 ms | 406,3 ms | 404 ms | 425 ms | 425 ms | 0 |
| dream_triage | 0 | — | — | — | — | — | sem amostra |
| fleet_gate | 0 | — | — | — | — | — | sem amostra |

- Total: 17 linhas, todas abaixo da amostra mínima de 30 por ponto.
- Falsos positivos `segredo=sim`: 8 (ver M4).
- O timeout de 2013 ms coincide com o limite de 2 s configurado.

## 7. Limites da verificação

- A interface real não foi aberta. Mudanças de UI (tela de Decisões, painel de memória com balão, borda do canvas, jev-latest) foram avaliadas só por código.
- Vigia verificado só em parte (seção 1).
- Já conhecidos e não relatados: sessão do Antigravity, janela maximizada com bounds nulos, abas sem PTY, sandbox do Codex, laço do Codex gpt-6.1-sol, `ags memory suggest`, `ags memory dream`, modal Daybreak.
- O Backend criou, via CLI, um rascunho de missão de teste (`df63f9e4`, `isTest=true`, sem agentes lançados) que permanece em rascunho.
