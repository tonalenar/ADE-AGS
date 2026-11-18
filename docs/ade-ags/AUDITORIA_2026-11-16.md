# Auditoria completa da ADE — 2026-11-16

## Resumo

Auditoria de leitura cobrindo os 2.217 arquivos `.ts`, `.tsx` e `.rs` de `src/` e `src-tauri/src/`, cerca de 435 mil linhas. A leitura incluiu os testes. A base foi o branch `fix/estabilidade-chat-pip-navegador` (`cf848dcb`), que é o `dev` (`4433cd53`) com dois commits ainda não mesclados: `7b8be22f` (chat) e `cf848dcb` (PiP). Fora esses dois commits, tudo vale para o `dev`.

Os lotes levantaram cerca de 470 achados. O orquestrador abriu no código todos os P0 e P1 e uma amostra dos P2. Nenhum código foi alterado e nada foi medido em execução: os números de desempenho dizem "não medido" quando não há número.

**Os sintomas relatados têm causa no código:**

| Sintoma | Causa principal (confirmada no código) |
|---|---|
| O app "travou e encerrou do nada" | O "encerrou" vem de um erro de render qualquer que troca a casca inteira pela tela de erro e mata todos os PTYs (`src/app/router.tsx:14` → `Terminal.tsx:678`). Um gatilho concreto é a paleta de comandos, que lança `ReferenceError` ao achar uma mensagem (`CommandPalette.tsx:421`). O "travou" vem do banco: o mutex do SQLite fica preso durante git, disco e Keychain em vários comandos, e os comandos Tauri síncronos esperam por ele na thread principal. A esses se soma o `pty_write`, que bloqueia workers do runtime. |
| Respostas chegam piscando | O `7b8be22f` só corrige respostas sem imagem. No fim de cada turno, a última fala muda de lugar na árvore e o Markdown inteiro remonta (`timelineModel.ts:133`). A linha de ferramenta troca de tipo na segunda ferramenta (`ConversationTimeline.tsx:735`). |
| PiP com quinas quadradas | O arredondamento usa máscara aninhada (`cef_native.rs:949`), que o SDK do macOS declara não suportada ("Nested masks … are unsupported"). Ela entra sempre que o grip vira buraco, ou seja, no hover. |
| Botões do PiP falham | O buraco do grip só existe com hover (`ViewTabsHost.tsx:168`), e as coberturas ficam até 120 ms em cache. Um clique antes do hover cai na página. |
| Navegador pisca ao mudar de forma | 1. `setChatBrowser(null)` quando o slot mede zero na transição (`RightPanel.tsx:507`). 2. `setHidden(true)` quando chega um recorte vazio (`cef_native.rs:912`). 3. No canvas, a vista é recriada quando o `cwd` muda (`CanvasView.tsx:1267`). |
| Miniatura cortada na primeira vez | Quando o agente abre o navegador flutuante sem medida prévia, a origem do zoom é um retângulo fictício de 560×400 (`agentBridge.ts:179`), e o painel não o republica enquanto flutua. A vista filha do CEF também nunca recebe `setFrame`, e o `was_resized` não tem efeito com janela nativa. |

Ainda sem causa: o crash do helper CEF de 14/11 (`EXC_BREAKPOINT` em `cef_execute_process`). A versão do framework confere (156.0.26), então a hipótese que resta é de entitlements ou JIT no build daquele dia.

## Bugs confirmados

Severidade: P0 trava ou fecha o app ou perde dados do usuário; P1 quebra uma função ou é risco de segurança; P2 degrada.

### P0

1. **Erro de render mata todos os terminais.** `src/app/router.tsx:14`. O `errorElement` existe só na rota raiz e os filhos não têm nenhum. Qualquer exceção de render troca o `AppShell` pelo `RouteError`, cada `<Terminal>` desmonta e chama `ptyKill`. O "Recarregar" não recupera nada. Um chunk lazy que falha depois de uma atualização tem o mesmo efeito.
2. **A paleta de comandos lança no render.** `src/features/palette/CommandPalette.tsx:421`. A `const icon` está declarada na linha 478 e é usada num `useMemo` anterior, o que cai na zona morta temporal (TDZ). Basta digitar um termo que bata com o texto de uma mensagem. Com o P0 1, isso mata todos os agentes.
3. **Canvas apagado ao abrir o app.** Os pontos são `src-tauri/src/canvas/mod.rs:171` e `src/features/canvas/store.ts:377`.
   - `read_file` devolve um mapa vazio para qualquer erro de leitura ou de parse.
   - O front então chama `syncBoards()` e salva.
   - O `save_board` regrava `canvas.json` com um board só.
   - Basta o arquivo estar truncado ou ilegível para os canvases de todas as pastas sumirem, sem ação do usuário.

### P1

| # | Achado | Onde |
|---|---|---|
| 1 | O `floors.json` ilegível faz o registro de andares sumir no próximo andar criado; os worktrees viram órfãos | `src-tauri/src/floors.rs:307` |
| 2 | O mutex do banco fica preso durante git, `gh`, disco e Keychain: Revisão (`git diff` até 180 s), diff de entrega, Reavaliar (`gh`), precheck, Iniciar missão (relê transcripts), "Finalizar", fim de tarefa com gate, listar contas | `missions/mod.rs:395,406,555,629,729`; `runs/supervisor.rs:527`; `accounts/commands.rs:41`; `memory.rs:882` |
| 3 | Comandos Tauri síncronos tomam o mutex na thread principal; com o item 2, a UI congela sem prazo | comandos `#[tauri::command]` não `async` que fazem `db.lock()`, por exemplo `gemini_desktop_task_update` e `restore_deferred_windows` |
| 4 | `pty_write` é `async` mas faz `write_all` bloqueante e sem prazo; uma TUI parada mais digitação esgota os workers e todo IPC async para | `src-tauri/src/terminal/pty_manager.rs:1229` |
| 5 | Um pânico no leitor do PTY deixa a aba viva e muda, e o agente trava no write | `pty_manager.rs:1051` |
| 6 | Pânico com slice de UTF-8 depois de `to_lowercase` (por exemplo, `İ`) | `src-tauri/src/runs/fixrounds.rs:200,599` |
| 7 | O aviso de parado e o Vigia colam texto e Enter sem checar `isWaitingForUser`, e podem aprovar um "Do you want to proceed?" do orquestrador | `src/features/missions/watcher.ts:223`; `vigia.ts:288` |
| 8 | Remover a regra "Sempre permitir" é otimista: se o IPC falha, a regra some da tela e continua aprovando | `src/features/chat/permissions/permissionsStore.ts:107` |
| 9 | A lista de rótulos sensíveis do computer use não tem "permitir/allow/aceitar/instalar/autorizar" | `src-tauri/src/computer_use/mod.rs:168` |
| 10 | O delimitador do briefing de memória não é escapado; um corpo com `<<<FIM_MEMORIA_APROVADA>>>` fecha o bloco UNTRUSTED | `src-tauri/src/memory/search.rs:391` |
| 11 | Em site real, corpos de requisição e resposta e os valores de `storage list` vão ao agente sem redação | `src/features/browser/networkDetail.ts:267`; `agentBridge.ts:363,608` |
| 12 | Um agente que usa o TCP legado com o token vira `Principal::Outside` e fura o escopo do canvas | `src-tauri/src/ipc/authz.rs:447` |
| 13 | O cursor do bus devolve o `last_seq` global e pula eventos além do `limit` | `src-tauri/src/bus.rs:161` |
| 14 | Descartar mudanças usa pathspec com glob; `[id].tsx` atinge `i.tsx` e `d.tsx` | `src-tauri/src/scm/commands.rs:140` |
| 15 | Um erro de leitura vira `{}` e regrava `~/.claude.json`, o que perde o login | `src-tauri/src/usage/trust.rs:116` |
| 16 | A mensagem some do composer quando o backend recusa o envio | `src/features/chat/ChatComposer.tsx:564` |
| 17 | Renomear trocando só a caixa sobrescreve o outro arquivo em volume sensível a caixa | `src-tauri/src/explorer/ops.rs:76` |
| 18 | Os sintomas da tabela do resumo (fala final remontada, ToolRow↔WorkGroup, máscara aninhada, buraco do grip, `setChatBrowser(null)`, vista recriada por `cwd`, origem 560×400) | ver o resumo |

**Decisão pendente do Ton:** contas Claude por chave de API passam `ANTHROPIC_API_KEY` no ambiente do agente (`pty_manager.rs:817-831`). O Claude CLI só aceita a chave assim, mas o AGENTS.md §2.3 proíbe segredo no ambiente de agente. O caminho seria um broker local de credenciais. A chave de API do Codex também vai parar em `auth.json`, porque é o `codex login` que a grava ali.

### P2 confirmados (seleção)

- `iphone/commands.rs:272`: todo erro do `devicectl` vira "falta Xcode" e a lista de aparelhos some, o que afeta o emparelhamento por Wi‑Fi.
- `iphone/session.rs:446`: a entrada enviada antes de a sessão começar é descartada e o agente recebe "ok".
- `real_browser/cef_native.rs:787`: um timeout de 30 s na criação do Portal deixa o browser e a NSView órfãos.
- `real_browser/cef_native.rs:363`: o pump do CEF roda a 30 Hz mesmo sem nenhum browser aberto.
- `conversa/claude_map.rs:338`: um stop por limite de tokens vira turno concluído, sem aviso de corte.
- `app/run.rs:889` e `database/connection.rs:61`: uma falha de migração ou do diretório de dados fecha o app sem aviso nativo.
- `chat/timeline/isolatedFrame.ts:23`: a CSP `navigate-to` não é aplicada por navegador nenhum, então o iframe pode navegar para fora (o mesmo vale para os apps MCP).
- `memory.rs:724`: `memory.list/get` não filtram `repo_key`, o que afeta os dados do SQLite antigo, hoje só leitura.

As listas completas, com cenário e evidência, ficam nos relatórios por lote, fora do repositório.

## Desempenho (não medido)

- **Chat:** a timeline inteira, a barra lateral (assinatura de `s.live` inteiro) e a medição de altura são recalculadas a cada quadro de streaming. A varredura de imagens roda sobre todo o texto a cada pedaço.
- **PTY:** o backend emite um evento por `read`, e o front faz um `term.write` por evento. O achado de 13/11 continua aberto.
- **CEF:** cada `place` reaplica frame, máscara, zoom e `was_resized`, mesmo sem mudança.
- **Missões:** os transcripts são relidos inteiros a cada passada, sem cache por arquivo.
- **Shell inicial:** o chunk `main` tem ~1,9 MB, número medido em 13/11.

## Auditorias anteriores

Os achados de `AUDITORIA_2026-11-13_PERFORMANCE*.md` sobre streaming, PTY, CEF e o shell inicial seguem **abertos**. Sobre o `AUDITORIA_2026-10-02.md`:
- o `Instant::now() + timeout` do broker foi corrigido no caminho IPC;
- o buffer da frota foi corrigido em parte;
- os índices de `runs` foram marcados como corrigidos.

Sobre o `AUDITORIA_2026-10-17_PERFORMANCE_E_JEV.md`, o lock do SQLite durante I/O segue **aberto** e se espalhou por missões, contas e memória.

## Roadmap: próximos passos

### Fase 1: parar de perder dados e de derrubar agentes (P0)

1. **Error boundaries por painel, abaixo da casca.** Um erro de render deve mostrar o erro só no painel e nunca desmontar `<Terminal>`. O mesmo vale para chunks lazy que falham. Impacto alto, esforço baixo.
2. **Corrigir a TDZ da paleta**, com um teste que digite um termo que bata com uma mensagem. Impacto alto, esforço baixo.
3. **Um helper único de JSON do usuário**, que leia com erro explícito, recuse gravar por cima de um arquivo ilegível e faça backup `.bak`. Vale para `canvas.json`, `floors.json`, `~/.claude.json` e afins. O front não deve salvar antes de um `canvas_load` bem-sucedido. Impacto alto, esforço médio.

### Fase 2: parar de travar

4. **Nenhum I/O com o mutex do banco preso.** Separar em duas fases: ler do banco, soltar o lock, fazer git, disco ou Keychain, e gravar de novo. Começar por Revisão, diff, Reavaliar, precheck, Iniciar, Finalizar, o gate da frota e as contas. Um lint ou teste deve impedir `db.lock()` em comandos síncronos. Impacto alto, esforço médio-alto.
5. **PTY robusto.** A escrita vai para uma thread ou fila por terminal, com limite. O leitor ganha guarda de pânico e emite sempre `pty-exit`. A saída passa a ir em lote por frame. Impacto alto, esforço médio.
6. **Cache incremental de transcripts** por arquivo (mtime, tamanho e offset), compartilhado por missões, títulos e atividade. Impacto alto, esforço médio.

### Fase 3: os sintomas visuais (com captura antes e depois)

7. **Chat sem salto:** a fala final no mesmo slot (`key` estável, sem trocar de pai), `ToolRow` e `WorkGroup` com a mesma raiz, e recálculo só do turno aberto, com seletores finos por conversa. Impacto alto, esforço médio.
8. **Superfície nativa do navegador com um único caminho de atualização:**
   - posicionamento diferencial, alterando só o que mudou;
   - `setFrame` também na vista filha;
   - máscara suportada (`masksToBounds` + `cornerRadius`, ou um path even-odd);
   - sem `setHidden` em frame transitório;
   - buraco do grip estático e hover por vista;
   - origem de zoom só a partir de medida real;
   - vista que sobrevive à troca de `cwd` e de modo.

   Impacto alto, esforço médio-alto.
9. **Testes de regressão de ponteiro e de forma para o PiP e a miniatura**, com eventos de ponteiro reais em vez de `click()`, troca de forma sem reabrir a vista, e o raio em cada `place`. Impacto médio, esforço médio.

### Fase 4: segurança e confiança

10. **Guarda única de escrita em terminal**, que nunca envia Enter com o terminal esperando o usuário. Vale para o Vigia, o aviso de parado e o `peer`. Impacto alto, esforço baixo.
11. **Envelope de dado não confiável padrão**, com o delimitador escapado. Vale para memória, saídas da página, design e Vigia. Impacto alto, esforço médio.
12. **Política única do que sai do navegador para o agente**, com redação de corpos, storage e cookies em site real. `confirm` e `reset` passam a perguntar. Impacto alto, esforço médio.
13. **Confirmação no computer use por categoria de ação**, não por lista de palavras. Impacto médio, esforço médio.
14. **Identidade forte no IPC:** aposentar o TCP sem PID, limitar o orçamento global e o tamanho de frame no MCP. Impacto médio, esforço médio.
15. **Credenciais fora do ambiente do agente** (broker local), se o Ton decidir. Impacto alto, esforço alto.

### Fase 5: aparelhos e evolução

16. **Diagnóstico tipado de descoberta e entrega** no iPhone e no simulador, separando Xcode ausente, timeout e não confiado. Também falta o erro quando o toque não chega. Impacto médio, esforço baixo.
17. **Ciclo cancelável de criação do Portal CEF**, supervisão dos helpers e o diagnóstico do crash de 14/11 (comparar as entitlements do build). Impacto médio, esforço médio.
18. **Encerramento com teto de tempo**: gravação de tela e CEF fora da thread principal ao fechar. Impacto médio, esforço baixo.
19. **Testes de comportamento no lugar de cópias de lógica e contratos por regex**: os de voz, permissões e streaming com imagem. Impacto médio, esforço médio.

## Método

- **Plano:** nove lotes disjuntos por área, só leitura, com um brief comum (arquivo:linha, cenário de falha e confiança obrigatórios). Alguns lotes foram divididos em partes e redisparados quando a cobertura ficou parcial.
- **Modelos escolhidos pelo Ton:** Hydrogen (Gemini 4) para o front, Luna (GPT‑6, `max`) para o Rust e Haiku 5.5 (`xhigh`) para o restante.
- **O que aconteceu com cada modelo:**
  - O Hydrogen não rodou pelo Cursor, porque faltou saldo semanal. Pelo Antigravity, caiu ou ficou mudo em todas as tentativas.
  - O Luna leu os lotes 4a, 4b e 5 completos, parou cedo nos lotes 4, 6 e 7 e bateu no limite de uso no meio.
  - Com o OK do Ton, os lotes restantes foram para o Haiku 5.5 `xhigh`, que leu 100% de cada lote.
- **Verificação:** o orquestrador (Opus 5.5) abriu no código todo P0 e P1 e uma amostra dos P2. Vários P0 foram rebaixados e alguns P2 foram promovidos por explicarem sintomas. Achados descartados: a migração v<4 (DROP deliberado de scaffolding vazio) e o palco 1280×800 da miniatura, praticamente inalcançável.
- **O que não foi feito:**
  - nenhuma execução do app, nenhuma captura de tela e nenhuma medição;
  - nenhum teste rodado;
  - os sintomas visuais seguem "explicados por leitura" até a captura de antes e depois na instância isolada (AGENTS.md §6.2).
