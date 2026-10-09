# Relatório — Teste completo v2 (squad Pro)

**Estado: consolidação documental concluída; validação GUI permanece incompleta.** Data: 2026-10-09. Missão: `efd083e9-682e-4de5-a4b0-2934d85248c9`. Base informada pelo Frontend: `378d9e5`. Consolidado pelo Reviewer em `cc/mission-efd083e9-682e-4de5-a4b0-3a5c8fce` (commit `a1571c1`); entregue pelo Orquestrador em `cc/mission-efd083e9-682e-4de5-a4b0-144244ac`, com AGS-022 e AGS-023 acrescentados.

## Resumo e método

O Reviewer reproduziu uma falha intermitente de comunicação CLI → frontend e conferiu no código os 13 achados enviados pelo Frontend. A comunicação voltou sem reinício. A causa da falta de resposta do JavaScript ainda não foi isolada; janela oculta/minimizada é hipótese, não conclusão.

O Orquestrador também informou os três gates verdes e perda intermitente de conexões entre integrantes. O Reviewer confirmou Backend aberto na listagem de abas, mas inacessível por peers. Os três logs completos do Backend foram recebidos e conferidos independentemente; todas as suítes passaram.

O Frontend fez revisão estática das telas solicitadas, sem abrir o app. Os achados dessa revisão abaixo têm **confirmação por código**, e seus passos são roteiros para reprodução; não representam execução manual de GUI nem injeção de falhas realizadas nesta missão. Não há evidência suficiente para declarar concluído o teste completo do ADE AGS.

Fontes recebidas:

- Frontend: `C:\Users\tonz1n\.ags\worktrees\9f10b542\docs\ade-ags\achados-frontend.md`, commit `1c0b2a0`.
- Reviewer: `docs/ade-ags/achados-reviewer.md` e saídas dos comandos CLI nesta revisão.
- QA: `C:\Users\tonz1n\.ags\worktrees\9fa8f030\docs\ade-ags\achados-qa.md` e `src/features/terminal/tests/qa_edge_cases.test.ts`, commit `1bf908a`. Código e cinco testes de caracterização conferidos; sem execução GUI. Testes não copiados para esta entrega documental.
- Backend: `C:\Users\tonz1n\.ags\worktrees\cd948421\docs\ade-ags\achados-backend.md`, commit `8663624adbfd6a27f99c41a3360314289d77a623`. Logs conferidos em `%TEMP%\ade-ags-cd948421-{rust,frontend,tsc}.log`; base `378d9e5870f8a68a4c77c3a9bcce0e972a1af94e`, árvore testada `ec00b59d4d91ffcb8ed4f6a81f832cbcc0cc3ae5`, CLI 1.8.7.

Consolidação atual: **3 altos, 8 médios, 12 baixos; nenhum bloqueante confirmado**. Inclui achados estáticos condicionais explicitados abaixo; não equivale a 23 falhas reproduzidas na GUI. Os achados QA estão incorporados nas respectivas gravidades.

Nenhum código do produto alterado. Nenhum reinício, `tauri dev` ou `cargo build --bin ags` executado pelo Reviewer. O erro conhecido do sandbox do Codex 0.161.0 está excluído.

## Suítes e cobertura

| Verificação | Resultado verificável |
| --- | --- |
| Rust — `cargo test --lib --bin ags` | Verde conferido no log: biblioteca 1.323 aprovados/10 ignorados; CLI 38 aprovados; zero falhas, saída 0, cacheHit:false |
| Frontend — `bun run test` | Verde conferido no log: 1.588 testes/185 arquivos; saída 0, cacheHit:false |
| TypeScript — `bunx tsc --noEmit` | Verde conferido no log: sem erros, saída 0, cacheHit:false |
| Reviewer — `ags test affected --dry-run` | Código 0; somente documentação, nenhuma suíte selecionada |
| Reviewer — `ags test affected` | Código 0, `passed:true`; somente os dois Markdown, nenhuma suíte selecionada. Revalidar se houver nova entrega |
| CLI `tab list` e `peers` | Sucesso; listagem das abas e conexões conferida |
| CLI `peer tell Orquestrador` | Falhou com timeout; posteriormente teve sucesso sem reinício |
| i18n | Frontend informou nenhuma chave estática ausente; catálogo tem teste de paridade. Não equivale a validação visual de toda chave dinâmica |
| GUI: Missões, Squads, Contas, memória, Histórico, Frota, Canvas e Novo agente | Revisão estática; execução manual não realizada nesta entrega |
| Terminais em branco, Claude/Codex/Shell, restauração, maximização e tela cheia | Código e cinco testes QA conferidos; GUI não exercitada |
| QA — `ags test affected` | QA informou Babel: 673 arquivos; tsc verde; 5/5 testes verdes. Sem saída bruta. Testes caracterizam comportamento atual; não são testes que falham antes de uma correção |

## Bloqueante

Nenhum confirmado nas evidências recebidas até aqui.

## Alto

### AGS-001 — A ponte CLI → janela expira enquanto comandos de leitura continuam funcionando

- **Origem/confirmação:** Orquestrador e reprodução dinâmica independente do Reviewer.
- **Local:** `src-tauri/src/ipc/bridge.rs:23,94,99`; `ipc/commands/tabs.rs:55`; `ipc/commands/peers.rs:519,578`; `src/features/orchestrator/cliBridge.ts:361`.
- **Passos:** com a missão aberta, executar `ags peers` e depois `ags peer tell Orquestrador "teste de comunicação"` na aba Reviewer. Em shell externo, o Reviewer usou `--from a1e806dc-6c25-43c2-82d1-e33069e14bc6`, após conferir a identidade em `ags tab list`.
- **Esperado:** mensagem entregue/enfileirada, ou diagnóstico específico da indisponibilidade.
- **Obtido:** listagem respondeu; envio terminou com código 1 e `La ventana no respondió a tiempo (¿está la app respondiendo?)`. Outra tentativa depois teve `sent:true`, sem reinício. Condição intermitente, sem gatilho visual isolado.
- **Impacto:** interrompe comunicação do squad. `peer tell` precisa consultar `tab.ptyId` no frontend antes de enviar; `peer check` precisa consultar `tab.screen`. `peers` lê o banco e não depende da ponte. O evento não tem confirmação de recebimento/reenvio ou fallback nesse fluxo.
- **Precisão da causa:** comprovado apenas que não chegou resposta dentro dos 15 s. `Responding` do processo, informado pelo Orquestrador, não garante disponibilidade do listener JavaScript. Ocultação/minimização, congestão ou listener indisponível seguem hipóteses. Não foi encontrada suspensão explícita do bridge ao ocultar a janela.
- **Backend B01:** duas tentativas de `ags tab send` ao Orquestrador retornaram timeout e código 1. Conferido em `ipc/commands/tabs.rs:459`: o envio consulta `pty_id_for_tab`, usando a mesma ponte. Incorporado aqui sem nova contagem; o relato não determina envio tardio.
- **Notify:** o prazo desse comando é **10 s**, não 15 s (`ipc/commands/notify.rs:57`). A notificação nativa vem depois da resposta frontend; o timeout também aborta esse caminho. A falha de `notify` foi relatada pelo Orquestrador, não reproduzida pelo Reviewer.

### AGS-014 — Integrante aberto perde alcance em peers durante a missão

- **Origem/confirmação:** Orquestrador relatou `ags peers` alternando entre quatro e dois integrantes, com Backend desaparecendo após receber tarefa e QA também perdendo ligação. Reviewer conferiu independentemente a ausência de Backend; não observou pessoalmente toda a alternância nem a ausência de QA.
- **Local do fluxo:** `src-tauri/src/ipc/commands/peers.rs:135` cruza `canvas::reachable` com abas abertas; `src-tauri/src/canvas/mod.rs` carrega o grafo e calcula alcance. O frontend reconcilia nós/arestas em `src/features/canvas/store.ts:270` e `board.ts:134`. A causa da alteração do grafo não foi isolada.
- **Passos observados:** iniciar o squad da missão e enviar tarefa aos integrantes; comparar peers durante a execução. No Reviewer, executar `ags tab list`, `ags peers --from a1e806dc-6c25-43c2-82d1-e33069e14bc6` e `ags peer check Backend --from a1e806dc-6c25-43c2-82d1-e33069e14bc6`.
- **Esperado:** integrante da equipe permanece alcançável enquanto sua aba segue aberta e sua ligação não é removida explicitamente.
- **Obtido:** `tab list` retorna Backend (`d41f9343-0c4f-475c-bb18-06fdd750a401`) na janela `main`; peers do Reviewer retorna Orquestrador, Frontend e QA, sem Backend. `peer check Backend` retorna código 1: `'Backend' não está conectado com você. Conectados: Orquestrador, Frontend, QA / Tests`.
- **Impacto:** integrante continua trabalhando, mas deixa de poder ser consultado/contatado pelo canal normal do squad. Distinto de AGS-001: a rejeição por alcance responde imediatamente, antes da ponte frontend.
- **Limite:** não há snapshot do grafo antes/depois nem reprodução determinística da remoção; não se atribui a causa a fullscreen, restauração ou reconciliação apenas pela leitura do código.


### AGS-015 — Terminal vivo e silencioso fica sem receber mensagem e sem aviso

- **Origem/confirmação:** QA 2.1; código e teste de callbacks conferidos. Gravidade ajustada de bloqueante para alto: falha condicional de entrega.
- **Local:** `src/features/terminal/terminalRegistry.ts:116,137,170`; consumidores em `src/features/missions/vigia.ts:109` e `src/features/memory/tabMemory.ts:35`.
- **Passos:** registrar terminal com PTY vivo que já exibiu prompt; chamar `sendWhenReady` sem nova saída do processo; esperar mais de 45 segundos.
- **Esperado:** entregar mensagem ao terminal pronto ou avisar indisponibilidade.
- **Obtido por código/teste:** `sawOutput` só observa saída futura. Sem saída, o timer desfaz a subscrição sem chamar `send`, `onSent` ou `onStalled` e sem remover a mensagem da fila. Teste QA avança 46 s e confirma ausência dos callbacks; não espiona escrita PTY.
- **Limite:** não significa que todo briefing inicial falha. Nova montagem/novo envio pode recuperar. Não há ligação causal estabelecida com o relato de QA receber apenas Enter.

**AGS-001, recorrência:** Orquestrador informou novo timeout em `peer check` e `tab output` por volta de 11:5x, após recuperação anterior. Mesmo achado, sem gatilho isolado.

## Médio

### AGS-002 — Criar Squad permite salvar um Lead sem capacidade de orquestração

- **Origem/confirmação:** F1; código conferido no frontend, validação e leitura backend.
- **Local:** `src/features/squads/SquadDialog.tsx:48,228`; `src-tauri/src/squads/store.rs:43,105,250`; `src/features/missions/MissionDialog.tsx:177`.
- **Passos:** Criar Squad → escolher Lead registrado sem orquestração ADE MCP, como `gemini-cli` ou `kimi-code` → preencher nome → salvar → usar em Nova missão.
- **Esperado:** impedir uma nova configuração que não pode liderar missão, com explicação antes de salvar.
- **Obtido:** o seletor de Lead não desabilita esse provedor; `ready` ignora a capacidade. O backend exige registro, mas não `ensure_orchestration` ao salvar. Ao ler o squad, marca `ProviderNotOrchestrating`, deixando o squad indisponível para iniciar.
- **Limite:** Shell é rejeitado pelo backend; não foi aceita a alegação de que qualquer opção sempre salva. Provedor apenas desinstalado pode ser configuração reutilizável e não constitui sozinho este achado.

### AGS-003 — Erros de carregamento de provedores/squads aparecem como ausência de opções

- **Origem/confirmação:** F2, com escopo corrigido por conferência do código.
- **Local:** `src/features/squads/SquadDialog.tsx:34`; `src/features/missions/MissionDialog.tsx:51`.
- **Passos:** simular rejeição de `get_roster` ou `squad_list`; abrir Criar Squad ou Nova missão.
- **Esperado:** distinguir erro de lista vazia e permitir tentar novamente.
- **Obtido:** `catch` troca o roster por `null` ou squads por `[]`, sem mensagem/retry. Criar Squad novo fica sem escolha de provedor; Nova missão pode indicar ausência de squads existentes.
- **Limite:** Nova missão em modo específico pode salvar o rascunho com provedor padrão mesmo sem roster. Não foi aceita a afirmação de bloqueio universal do botão Criar nessa tela.

### AGS-004 — Configurar pools seleciona Claude Code mesmo com outro agente em uso

- **Origem/confirmação:** F3, código conferido em ambos os componentes.
- **Local:** `src/features/accounts/ContasSection.tsx:240`; `AccountsManager.tsx:96,153`.
- **Passos:** com Codex instalado e Claude Code ausente/sem contas, Configurações → Contas → Pools e failover → Configurar.
- **Esperado:** abrir configuração aplicável a um agente disponível, ou escolher o provedor.
- **Obtido:** `manage({agentId:"claude-code"})` fixa a seção. Como esse agente não está em `shown`, o painel mostra “Nenhuma TUI instalada”, apesar de existir Codex. Com Claude instalado, seleciona Claude independentemente do painel em uso.

### AGS-005 — Preferências mantêm valor otimista após falha ao salvar

- **Origem/confirmação:** F4, código conferido.
- **Local:** `src/features/settings/SandboxSetting.tsx:38`; `FixRoundsSetting.tsx:29`.
- **Passos:** simular falha de `db_set_setting`; alterar sandbox para `strict` ou o teto de rodadas.
- **Esperado:** comunicar falha e restaurar/sinalizar o valor não persistido.
- **Obtido:** estado visual atualizado antes do IPC; `catch(console.error)` não reverte nem apresenta erro. O backend conserva o valor anterior. Não há evidência de mudança real de política apesar da seleção visual.

### AGS-006 — Falha ao resolver pool cria uma aba com referência de conta inválida

- **Origem/confirmação:** F11; cadeia conferida até o aborto do lançamento.
- **Local:** `src/features/tabs/wizard/NewAgentDialog.tsx:135`; `src/features/accounts/pools.ts:74`; `src/features/terminal/Terminal.tsx:432`.
- **Passos:** selecionar `pool:Trabalho` em Novo agente; simular rejeição de `pool_pick`; confirmar abertura.
- **Esperado:** manter o diálogo aberto para corrigir a conta/pool.
- **Obtido:** aparece toast de erro, mas o `catch` devolve `pool:Trabalho`; `onConfirm` cria a aba e fecha o diálogo. O terminal tenta `accountEnvFor` com essa referência e, quando rejeitada, escreve `terminal.accountMissing` e muda para `exited`.
- **Gravidade:** elevada de baixo para médio porque o erro de configuração ainda cria uma aba cujo processo não pode iniciar. Sem reprodução ao vivo/injeção de falha nesta missão.


### AGS-016 — Resize durante criação assíncrona do PTY pode ser perdido

- **Origem/confirmação:** QA 1.3; corrida confirmada por leitura, sem reprodução visual/teste de integração.
- **Local:** `src/features/terminal/Terminal.tsx:477,499,500,591`.
- **Passos:** atrasar resposta de `ptyCreate`; mudar grade A para B; deixar expirar debounce de 120 ms antes da resposta; concluir criação sem novo resize.
- **Esperado:** enviar B ao PTY criado com A.
- **Obtido:** resize retorna com `ptyIdRef` nulo. Ao concluir criação, `sentSize` recebe grade atual B sem enviá-la ao backend; eventos iguais a B são ignorados. Processo fica com A até outra mudança de tamanho.

### AGS-017 — Bounds maximizados sobrescrevem dimensões normais de restauração

- **Origem/confirmação:** QA 4.2; persistência/restauração conferidas, efeito visual não medido.
- **Local:** `src/features/tabs/persistence.ts:178`; `src-tauri/src/window/manager.rs:58,64`.
- **Passos:** salvar janela normal pequena; maximizar; salvar/fechar; reabrir e desmaximizar em sessão de teste separada.
- **Esperado:** preservar tamanho normal para restauração, conforme comentário backend.
- **Obtido por código:** `outerSize`/`outerPosition` atuais sobrescrevem bounds sem consultar estado maximizado ou preservar bounds normais. Backend aplica números persistidos antes de maximizar. Tamanho normal anterior é perdido; tamanho exato após desmaximização depende do sistema e não foi observado.
- **Limite:** abrir sempre maximizado é escolha documentada; este achado trata da perda dos bounds normais.

### AGS-018 — Troca de tela pode perder foco quando o campo anterior desmonta

- **Origem/confirmação:** QA 5.1, restringido a páginas sem foco próprio; estrutura React conferida.
- **Local:** `src/app/AppShell.tsx:293`; `src/app/RouteModal.tsx:26`; `src/shared/ui/useFocusInside.ts:27`.
- **Passos:** focar campo em tela cheia; navegar por atalho para Squads, sem autofocus próprio; inspecionar foco após desmontagem do campo anterior.
- **Esperado:** foco dentro da página nova.
- **Obtido por código:** `RouteModal` compartilhado continua montado no AppShell. Hook depende só do ref estável e não reage à rota; não há reposicionamento nesse caminho quando o elemento focado desmonta.
- **Limite:** Skills e Histórico focam seus inputs ao montar; exemplo QA entre essas duas páginas não demonstra falha. Sem observação GUI de foco/body nesta missão.

## Baixo

### AGS-007 — Tooltip de fechar agente permanece em espanhol

- **Origem/confirmação:** F5, literal conferido.
- **Local:** `src/features/tabs/TabItem.tsx:133`.
- **Passos:** idioma pt-BR ou en → passar o mouse sobre X da aba.
- **Esperado:** tooltip traduzido.
- **Obtido:** `title="Cerrar"`. A chave `tabs.close` já existe.

### AGS-008 — Rótulo do orçamento em pt-BR usa tradução de verbo

- **Origem/confirmação:** F6, catálogo e uso conferidos.
- **Local:** `src/i18n/locales/pt-BR.json:1351`; `src/features/missions/MissionDialog.tsx:243`.
- **Passos:** pt-BR → Nova missão → configuração do orçamento.
- **Esperado:** “Orçamento da execução” ou equivalente nominal.
- **Obtido:** “Executar orçamento”.

### AGS-009 — Parte dos rótulos da memória e de QA não acompanha o idioma

- **Origem/confirmação:** F7 parcialmente aceito.
- **Local:** `src/i18n/locales/pt-BR.json:1928`; `src/features/memory/SharedMemoryPanel.tsx:531,637`.
- **Passos:** pt-BR → Squads ou detalhe da missão → papel QA; abrir revisões de memória com ator Lead/Worker/Dreamer e origem de tarefa.
- **Esperado:** rótulos localizados de testes, tarefa e ator.
- **Obtido:** `QA / Tests`, `Task`, e atores `Lead`/`Worker`/`Dreamer` fixos no código.
- **Limite:** “Run Facts” é usado como nomenclatura de produto em várias mensagens; sem requisito de tradução, não foi tratado isoladamente como bug.

### AGS-010 — Falha de consulta da memória aprovada/rejeitada parece lista vazia

- **Origem/confirmação:** F8, código conferido.
- **Local:** `src/features/memory/MemoryPanel.tsx:62`.
- **Passos:** simular falha de `query_memory`; abrir aba Aprovadas ou Rejeitadas.
- **Esperado:** mensagem de erro, preservando distinção entre falha e ausência de entradas.
- **Obtido:** `catch` grava `[]`; a tela mostra estado vazio. Não indica perda de memória no banco, apenas resultado visual incorreto.

### AGS-011 — Falhas de retry/rejeição de memória não recebem feedback

- **Origem/confirmação:** parte de F9, código conferido.
- **Local:** `src/features/memory/RepoSyncNotice.tsx:55`; `DreamSection.tsx:33`.
- **Passos:** simular falha IPC de `retryRepoSync`, ou de uma proposta em Rejeitar sonho; clicar no respectivo botão.
- **Esperado:** feedback do novo erro/resultado parcial; retry com estado ocupado.
- **Obtido:** erros descartados por `catch(() => undefined)`. Retry não tem guarda de clique ocupado; rejeição segue para recarregamento sem contabilizar falhas.
- **Limite:** não foi comprovado desaparecimento do sonho. Aprovação usa `approveBulk`/`decideAll`, que já captura falhas por item e devolve `failed`; essa parte de F9 foi descartada.

### AGS-012 — Alguns resumos e corpos truncados não oferecem leitura completa no próprio componente

- **Origem/confirmação:** F10, classes e estrutura conferidas; sem captura visual.
- **Local:** `src/features/missions/MissionsPage.tsx:871,884`; `src/features/squads/SquadsPage.tsx:89,149`; `SquadDialog.tsx:294`; `src/features/missions/MissionDialog.tsx:291`; `src/features/memory/MemoryPanel.tsx:210`.
- **Passos:** usar título/modelo longo ou corpo com mais de quatro linhas; visualizar resumo em janela estreita ou detalhe de memória; tentar obter conteúdo completo por hover/expansão.
- **Esperado:** tooltip, quebra ou expansão que disponibilize o texto completo nesse componente.
- **Obtido:** `truncate`/`line-clamp` sem tooltip ou expansão local nesses trechos. Corpo da memória aprovado/rejeitado fica em quatro linhas.
- **Limite:** não significa ausência do conteúdo no banco ou impossibilidade de lê-lo em qualquer outra tela. Frota e Histórico têm ações adicionais; truncamento isolado nesses cards não foi contado como defeito distinto.

### AGS-013 — Formatação de datas segue locale do sistema, diferindo do idioma do app

- **Origem/confirmação:** F12, chamadas conferidas.
- **Local:** `src/features/missions/PlanLimitsPanel.tsx:20,40`; `src/features/memory/DreamSection.tsx:46`; `src/features/canvas/RoutinesPanel.tsx:49`; `ChatPanel.tsx:60`.
- **Passos:** sistema em en-US, app em pt-BR → visualizar datas de limites, sonhos, rotinas e chat.
- **Esperado:** formatação consistente com o idioma escolhido, como em `SharedMemoryPanel.tsx:644`.
- **Obtido:** `toLocaleString()`/`toLocaleTimeString(undefined, ...)` usa locale do runtime. É inconsistência de apresentação, sem erro comprovado de timestamp/fuso.


### AGS-019 — Alças de resize continuam interceptando borda maximizada

- **Origem/confirmação:** QA 4.3; renderização/handlers conferidos, sem captura visual.
- **Local:** `src/app/ResizeHandles.tsx:6,18`; `src/app/AppShell.tsx:234`.
- **Passos:** maximizar; clicar nos seis pixels externos das bordas.
- **Esperado:** sem cursor/alça de resize em estado maximizado.
- **Obtido por código:** oito overlays fixos, z-index 9999, continuam ativos; mousedown chama `preventDefault` e `startResizeDragging` sem consultar estado maximizado.
- **Limite:** não foi provado que botões inteiros ficam inacessíveis; somente interceptação da faixa de borda.

### AGS-020 — Atalho da seção em sub-rota exige duas ações para voltar

- **Origem/confirmação:** QA 5.2; função, comentário de contrato, rota real e teste conferidos; ajustado para baixo.
- **Local:** `src/app/shortcuts.ts:118`; `src/app/router.tsx:21`.
- **Passos:** com abas abertas, entrar em `/skills/<id-existente>` e usar atalho de Skills.
- **Esperado:** conforme comentário de `resolveGoto`, estando na seção retornar à terminal.
- **Obtido:** igualdade estrita retorna `/skills`; só segunda ação retorna ao workspace.
- **Limite:** `/marketplace/plugin-123` citado por QA não é rota declarada; exemplo descartado. Escape/repetição do atalho continuam disponíveis.

### AGS-021 — Valor inválido em memory search retorna código operacional

- **Origem/confirmação:** Backend B02; código e reprodução CLI independente do Reviewer.
- **Local:** `src-tauri/src/bin/cli.rs:282,404,407`; `src-tauri/src/ipc/protocol.rs:184`; `src-tauri/src/ipc/commands/missions.rs:258`.
- **Passos:** executar `ags memory search cargo --limit banana`, `ags memory search cargo --at banana` e, como controle, `ags memory search`; conferir código de saída após cada comando.
- **Esperado:** código 2 para uso incorreto, conforme ajuda CLI (`0 ok; 1 comando falhou; 2 uso incorreto; 3 app não corre`).
- **Obtido:** valores inválidos produzem mensagens claras de validação, mas código 1; consulta ausente produz código 2. CLI só reconhece erro de uso remoto pelo prefixo de argumento obrigatório ausente.
- **Impacto:** automação confunde erro de argumento com falha operacional. Nenhuma leitura/escrita de memória ocorre nos comandos inválidos.

### AGS-022 — Aviso automático de agente parado dispara com o agente trabalhando

- **Origem/confirmação:** Orquestrador, observação direta durante esta missão; causa não investigada no código.
- **Local:** aviso automático do ADE AGS enviado ao orquestrador (detector de ociosidade) e mensagens do Vigia.
- **Passos:** com o squad em execução, aguardar o aviso “O agente "Reviewer" recebeu uma tarefa há 2 min 03 s e está parado há 2 min 01 s (não escreveu nada desde que recebeu a tarefa)”; em seguida executar `ags peer check Reviewer`.
- **Esperado:** aviso só quando o agente estiver de fato ocioso.
- **Obtido:** a tela do Reviewer mostrava `• Working (4m 39s • esc to interrupt)` com comandos em execução, e o Reviewer fez novos commits logo depois. O Vigia também repetiu cobranças já atendidas (Backend “sem commit” depois do commit `8663624`).
- **Impacto:** ruído para o orquestrador e risco de reenviar tarefas a agentes ocupados. Pode estar ligado a AGS-001 (leitura de tela pela mesma ponte), hipótese não verificada.

### AGS-023 — Tarefa original é reenviada a integrantes já liberados

- **Origem/confirmação:** Orquestrador, observação direta após o encerramento da missão; causa não investigada no código.
- **Local:** fluxo de entrega de tarefas do squad (briefing/reenvio automático); origem não isolada.
- **Passos:** concluir a missão, avisar cada integrante do encerramento (`ags peer tell <nome> "missão concluída"`) e aguardar alguns minutos sem enviar nada.
- **Esperado:** nenhuma tarefa nova chega a integrante liberado sem ação do orquestrador.
- **Obtido:** Frontend, Reviewer e QA / Tests voltaram a receber a tarefa original. Frontend e Reviewer reconheceram a entrega anterior e não alteraram nada. O QA refez o trabalho e criou um commit novo (`adc2a26`, +23 linhas em `achados-qa.md`). Em seguida chegaram avisos de “recebeu uma tarefa há 2 min” para o Frontend (ver AGS-022).
- **Impacto:** gasto de tokens e cota, além de commits duplicados ou trabalho refeito por agentes já liberados. Agentes menos cautelosos podem alterar entregas já consolidadas.

## Descartados e hipóteses pendentes

| Item | Decisão e motivo |
| --- | --- |
| Backend B01 — timeout tab send | Incorporado a AGS-001: mesmo pty_id_for_tab e bridge de 15 s, confirmado por código e duas saídas relatadas. Sem achado duplicado; não determinado eventual envio tardio |
| Sandbox do Codex 0.161.0 no Windows | Excluído por instrução da missão; já conhecido |
| Frontend F13 — tooltip “Enter” | Descartado: rótulo convencional da tecla enviada ao dispositivo; literal sozinho não prova defeito |
| F9 — aprovação vira rejeição de Promise por falha de proposta | Descartado: `approveDream` → `approveBulk` → `decideAll` captura falhas por item e retorna `failed` |
| F9 — rejeição com erro faz sonho desaparecer | Não confirmado: handler recarrega lista; não demonstra exclusão local/backend após rejeição malsucedida |
| F1 — qualquer provedor, inclusive Shell, salva como Lead | Corrigido: `validate_provider` rejeita Shell/não registrado; AGS-002 se restringe à falta de capacidade de orquestração |
| F2 — Nova missão sempre fica impedida de criar após erro de roster | Corrigido: o rascunho específico pode usar o provedor padrão; mantém-se o erro invisível/ausência aparente de opções |
| F7 — todo termo “Run Facts” deve ser traduzido | Não contado isoladamente: nomenclatura usada consistentemente no catálogo; falta requisito de tradução |
| F10 — `truncate` sozinho prova conteúdo inacessível em todo app | Não aceito: ações de detalhe/exportação/resultado podem existir. AGS-012 descreve apenas ausência de acesso completo local conferida |
| REV-02 — restauração de janelas secundárias em escala >100% | Hipótese forte por código: salva unidades físicas e passa para builder em unidades lógicas. Tauri 2.12 confirma as unidades. Sem execução visual; pendente de sessão visual dedicada, não contado como bug reproduzido |
| QA recebeu apenas um Enter no briefing inicial | Ocorrência relatada pelo Orquestrador, pendente de transcript/log de envio e confirmação QA. Não prova por si só perda de texto no PTY, nem que a causa seja AGS-014. Não contado como bug separado ainda |
| Executor `helper_unknown_error` e ausência de `ADE_TAB_ID` no shell externo | Limitações do ambiente da revisão; não atribuídas ao produto. Identidade conferida e `--from` usado explicitamente |
| `unwrap`/`expect` localizados na revisão Rust | Não houve cadeia demonstrada de entrada do usuário até panic; testes/invariantes internas não geram achado por si sós |

## Descartados QA e avaliação dos testes

| Item | Conferência e decisão |
| --- | --- |
| 1.1 — zero é bloqueante/fatal | Não aceito: erro propagado, sem panic. FitAddon impõe mínimos e xterm tem padrão 80×24; não demonstrado caminho UI enviando zero. Validação defensiva é sugestão |
| 1.2 — aba oculta nunca recupera fit | Não demonstrado: visibility/transform preservam tamanho; ResizeObserver reage a 0→positivo, há onDimensionsChange, fit pré-launch e dois rAF. Roteiro mistura ocultação sem perda de tamanho com container zero |
| 2.2 — Shell nunca recebe retry de Enter | Generalização descartada: watchStart envia Enter após 25 s nos fluxos com timings, sem exigir marcador. Teste só exercita predicado, sem perda real de Enter. Retry cego pode reexecutar comando |
| 2.3 — rejeitar batch arbitrário é bug | Restrição explícita: util/launch.rs explica riscos de interpretação/injeção; erro exige executável/intérprete. Shims npm reconhecidos têm fluxo próprio |
| 3.1 — cold boot sempre abre aba zero | Falso positivo: layoutStore.ts:130/198 restaura focusedActive salvo após hidratação; AppShell inicia sincronização antes de carregar estado. Teste isolado de hydrateFromBackend omite integração |
| 3.2 — cwd ausente exige fallback para home | Sem requisito estabelecido; erro explícito evita executar tarefa em projeto errado. Recuperação assistida é sugestão, não falha fatal do app |
| 3.3 — scrollback oculto é regressão | Política de desempenho documentada e coberta por persistenceScrollback.test.ts; há snapshots de saída/fechamento. Crash pode perder saída recente, mas teste repete política existente |
| 4.1 — abrir maximizado é bug | Comportamento deliberadamente documentado, sem requisito contrário |
| 5.3 — Home deve fechar com Escape | Home é rota base explicitamente distinta de RouteModal; sem contrato exigindo Escape |

Faltam testes de integração que preservem resize durante criação lenta e que exercitem troca de rota com campo focado. O teste de prontidão deveria observar também a escrita efetiva, limpar registro/fila/store após cada caso e exigir entrega ou diagnóstico, em vez de apenas confirmar silêncio. O teste de cold boot precisa incluir layoutStore antes de afirmar perda da aba ativa. Essas observações tratam dos cinco testes enviados; não afirmam ausência de toda cobertura existente.


## Lacunas de validação e próximos testes

Os logs das três suítes foram conferidos; falta teste manual dos casos QA; a entrega QA foi conferida por código e testes de caracterização, conforme fontes e avaliação dos testes. Para os defeitos condicionais, executar injeção controlada de falha IPC em roster/squads, preferências, memória e pools, verificando mensagem, preservação de estado e recuperação. Para AGS-001, comparar janela visível, minimizada e oculta com log de emissão/recebimento/resposta do bridge; não basta o processo estar `Responding`. Para AGS-014, capturar o grafo e as abas antes/depois da perda de alcance, distinguindo alteração de arestas de estado de persistência; registrar transcript do briefing QA e escritas no PTY. Para REV-02, medir posição/tamanho na restauração de janela secundária com escala 125%/150%, sem reiniciar esta missão em andamento.

O Reviewer não adicionou testes de produto nem repetiu as suítes completas. As lacunas acima são cenários ainda sem evidência nesta missão, não afirmação de ausência de todos os testes existentes no repositório.
