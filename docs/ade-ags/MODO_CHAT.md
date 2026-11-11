# Modo chat (estilo T3 Code)

Uma terceira forma de ver o trabalho, ao lado das abas e do canvas: uma sidebar de conversas e, ao lado, a conversa aberta ou a tela de conversa nova. O layout segue o T3 Code (MIT): sidebar de 256 px, cabeçalho de 52 px, composer de vidro com cantos de 16 px e coluna de 736 px.

## Estado: F1 (casca), experimental

- Fica **desligado** por padrão. Para ligar: Configurações → Avançado → "Modo chat (experimental)".
- Ligado, aparecem:
  - o seletor `Chat | Abas | Canvas` no topo do chat;
  - um botão "Chat" na barra de abas;
  - o atalho **Ctrl+Shift+L**. Com o modo desligado, o acorde segue para o terminal.
- **Uma conversa é uma aba de agente** (a TUI real, num PTY). A conversa nova abre o agente com:
  - a pasta;
  - o modelo e o esforço (`withModel`, os mesmos flags das missões);
  - a conta ou pool (`resolveAccountChoice`);
  - a permissão e o Plano (ver a tabela abaixo).

  Depois manda o prompt quando a TUI fica pronta (`sendWhenReady`). A aba aparece também nas abas, no canvas e na CLI.
- O composer cola a mensagem na TUI e envia (`pasteIntoTab`).
- A sidebar lista os agentes abertos da janela (sem os terminais de shell), os mais novos primeiro.

## Timeline, permissões e painel (caminho A)

- **A conversa é lida do transcript do agente** (Claude Code e Codex), o mesmo arquivo que o canal estruturado já acompanha.
  - `canal/timeline.rs` transforma as linhas em itens: mensagens, falas, ferramentas (tipo, caminho, `+/−`, status, saída) e fins de turno.
  - O comando `conversation_timeline(tabId)` lê só o fim do arquivo (até 4 MB) e acha o arquivo pelo id da aba, nunca por um caminho vindo da janela.
  - O laço do canal avisa `cc-conversation-grew` quando o arquivo cresce, e a janela relê.
- **Desenho (prancheta 2):** cada turno tem a bolha da pessoa e o fold "Trabalhou por …" com as ferramentas e falas intermediárias. A resposta final e o cartão "N arquivos alterados" (com "Abrir diff") ficam fora do fold. Enquanto o agente trabalha, aparece "Trabalhando há …".
- **O terminal do agente** fica numa gaveta de 280 px (botão no cabeçalho), posicionada por slot e sem remontar. Agentes sem transcript continuam com o terminal como corpo da conversa.
- **O terminal da conversa** (o >_ do cabeçalho, tecla T do painel): na conversa de TUI com timeline, o >_ alterna a
  gaveta do agente. Nas outras (por protocolo, ou TUI que já é o corpo), abre a aba **Terminal** do painel direito: um
  shell de verdade (PTY) na pasta da conversa (`RightPanel.tsx::ShellSurface`, `shellTerminal.ts`).
  - O shell é o de login da pessoa (`"$SHELL" -l`, lido de `agentSearchPath`; o zsh no macOS), numa aba de shell da
    pasta. O agente de shell do app roda `bash`, e no macOS isso abria o bash 3.2 com o aviso do zsh. A aba com esse
    shell é reaproveitada, como o navegador da pasta; dois pedidos seguidos dão uma aba só. Criá-la não troca a conversa
    aberta, e ela aparece no modo Abas.
  - O retângulo do slot é medido em relação à casca do chat a partir do PAI do slot (`rectInShell`): o slot carregava o
    mesmo atributo da casca (`data-chat-shell`) e o terminal aparecia no canto de cima da janela, por cima da sidebar.
  - Como o navegador, ela não é montada no painel: o painel publica o slot (`useChatStore.shell`), e
    `placementsFrom`/`chatPlacements` a posiciona. Fechar o painel ou trocar de conversa só a esconde.
  - **O agente da conversa usa o mesmo terminal** para comando interativo (login, código de verificação, pergunta,
    assistente `npx`): `ags tab create --agent bash --initprompt "supabase login"` chamado de uma conversa
    (`ADE_TAB_ID=thread:<id>`), ou `--in-chat` de qualquer conversa ou aba do chat. A CLI manda quem chama (`from`) no
    `tab.create`; o backend (`ipc/commands/tabs.rs::chat_terminal_target`) troca a pasta pela da conversa (a do
    registro da conversa, ou a da aba) e pede ao front `tab.create` com `chatShell`; o `cliBridge` abre a aba Terminal
    do painel (`shellTerminal.ts::openChatTerminal`) e devolve o id do shell (`reused`, `visible`). Depois,
    `ags tab send`/`tab output` nesse id. A pessoa digita no mesmo PTY, e o agente vê com `tab output`. `--new-tab`
    volta à aba comum. Não há tool MCP: as de aba não são expostas por MCP.
  - Num shell (`bash`, inclusive este), `tab send` e o primeiro comando vão como linha crua, uma vez só
    (`tabs.rs::submit_style`): sem as novas tentativas das TUIs, que digitavam de novo um código num prompt sem eco,
    e sem a ficha do ponto de restauração, que guardaria o texto (pode ser um código) no banco.
  - Sem como abrir o terminal (sandbox, app fechado, erro), a skill manda o agente pôr o comando num bloco ```bash, um
    por bloco, para a pessoa usar o **Rodar** ou colar no terminal ao lado; nunca rodar o interativo no shell
    escondido do agente.
- **Blocos de código** (`timeline/CodeBlockFrame.tsx`, `codeRun.ts`): cada bloco ganha **Copiar** (o código, sem o
  fim de linha). Bloco de shell (`bash`, `sh`, `shell`, `zsh`, `console`…) ganha também **Rodar**, que abre o terminal
  da conversa e manda o comando com um Enter (`terminalRegistry.runInTerminal`, sem as novas tentativas de Enter das
  TUIs). Num bloco `console`, vão só as linhas `$ …`, sem o prompt. Nada roda sem o clique. Fora da conversa aberta (sem
  `RunCodeContext`), o bloco só copia. O `Markdown` compartilhado recebe a moldura por `renderCodeBlock`.
- **Copiar a mensagem** já existia: ao passar o mouse, sob cada fala e cada balão (`MessageActions`), leva o Markdown.
- **Aprovações:**
  - O detector do canvas (`terminalPrompts.ts`) lê o diálogo da TUI.
  - O composer mostra Recusar / Sempre nesta sessão / Aprovar e manda a tecla da opção (`answerTerminalPrompt`).
  - O canal também avisa `cc-conversation-approval`, que a sidebar usa para o selo "Aprovação".
- **Parar:** com o agente trabalhando e a caixa vazia, o botão vira Parar e manda Esc à TUI.
- **Permissões** (os quatro modos do T3), passadas na abertura da conversa (`chatModel.withAccess`):

  | Modo | Claude Code | Codex | Gemini |
  |---|---|---|---|
  | Supervisionado | nada | nada | nada |
  | Aceitar edições | `--permission-mode acceptEdits` | — | `--approval-mode auto_edit` |
  | Auto (padrão) | o nível seguro das missões | o nível seguro das missões | o nível seguro das missões |
  | Acesso total | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--yolo` |

  - Plano: `--permission-mode plan`, só no Claude.
  - Um modo que o agente não tem nunca dá mais permissão do que a pedida.
- **Seletor (prancheta 3):**
  - painel amplo de três colunas com trilho de agentes, favoritos (no `localStorage`), modelos com busca e raciocínio à direita; conta da conversa fica no rodapé;
  - em conversas novas e por protocolo, o trilho permite escolher entre os agentes disponíveis; numa conversa por TUI ele fica no agente da sessão, porque trocar o executável do PTY não preserva a sessão. Nas conversas por protocolo, trocar de agente pede confirmação e só acontece entre turnos;
  - esforço, modos de acesso e, quando a matriz e o catálogo confirmam suporte para a superfície e o modelo selecionados, Standard/Fast ficam reunidos no painel; um esforço incompatível com o modelo selecionado é limpo;
  - o painel reduz o esforço a um seletor compacto em janelas estreitas; `Configurações > Aparência` também permite escolher as famílias de fonte da interface e do código, inclusive um nome instalado localmente;
  - o modo Plano continua como controle próprio, pois altera o lançamento ou o estado da conversa.
- **Sugestões no composer (estilo T3):** `@` sugere agentes do time e arquivos com mudanças no Git, além de abrir o seletor de arquivo; `/` abre as superfícies e ações ADE; `$` sugere skills compatíveis e anexadas à conversa, com acesso à gestão de skills. Setas, Enter e Escape navegam o menu. As ações usam os painéis e serviços existentes da ADE.
- **Contexto e objetivos:** `/compact` usa `thread/compact/start` no Codex estruturado e o comando nativo no Claude Code estruturado; nas TUIs, o comando segue para o CLI compatível. Claude Code aceita `/compact [instruções]`; Codex pelo app-server não aceita instruções customizadas. `/goal` do Codex é persistido pelo app-server e na ADE, com pausar/retomar; no Claude Code é encaminhado ao comando nativo, e o espelho local permanece até limpar porque o protocolo não informa conclusão confiável. `/autocompact` encaminha o ajuste nativo do Claude Code. `/clear` reinicia a sessão do provedor em conversas estruturadas, encerra o processo ocioso, limpa o objetivo ligado à sessão e conserva a timeline local; a ação aguarda o turno terminar e não passa com pedidos pendentes. Nas conversas estruturadas do Claude Code, Configurações permite ajustar o limite por perfil usando `--settings` apenas naquela sessão; isso não altera configurações globais nem as TUIs. O ajuste do limite ainda não se aplica às sessões TUI. Outros motores não mostram comandos sem suporte.
- **Rodapé do composer (estilo T3):** à esquerda só o «+» (`ComposerMoreActions`: anexar, rascunho guardado, câmera e gravação, sempre montado) e o chip «Para quem» do time (`TeamTargetSwitch`, só ícone em coluna estreita); à direita o seletor de modelo e o modo, o ditado e o enviar redondo. Todas as ações seguem acessíveis por `aria-label`. O mesmo layout vale para a pergunta lateral (a prop `compact` foi removida).
- **Conversa lateral:** `/side` ou o painel “Pergunta lateral” cria uma conversa independente para as conversas por protocolo (Codex, Claude Code, OpenCode, Antigravity e Cursor). Como no Side chat do T3 Code, a tela mostra o histórico da conversa de origem na mesma timeline do chat principal (com o mesmo estado de trabalho), o cabeçalho é enxuto (título, “Trazer para conversa”, excluir e nova) e o composer é compacto: o seletor de agente, modelo e permissão fica na barra; anexo e microfone ficam à vista; arquivo, câmera e gravação vão para “Mais ações”. A pergunta lateral nasce como **cópia da conversa de origem** (fork nativo da sessão do agente, `conversa/fork.rs`), no último ponto estável, e a primeira mensagem vai só com a pergunta: o Claude Code usa `--resume <sessão> --fork-session --session-id <nova>` e o Codex usa `thread/fork` com `lastTurnId` (o último turno terminado da origem, mesmo com ela trabalhando). Com a origem **no meio de um turno**, o Claude corta a cópia no último ponto estável: `--resume-session-at <uuid>`, o uuid da última mensagem do agente no último turno **concluído** (a ADE o guarda em `chat_run.end_uuid` no fim de cada turno concluído); a pergunta também recebe um pequeno digest do que a origem fez depois desse ponto. Quando a **sessão não abre** na pergunta (outro agente ou outra conta que a da origem, motor sem fork nativo como OpenCode, Antigravity, Cursor e agente ACP local, sem ponto estável, ou se a abertura do fork falhar), a pergunta leva o **contexto portátil**, como o T3 faz num fork entre provedores (`fork_mode = portable`): o histórico da origem como texto (falas, arquivos alterados e lidos, comandos recentes sem a saída, plano), sob o teto de 64 000 bytes, sem o raciocínio, as saídas, os anexos nem segredos (`conversa/redacao.rs` esconde tokens, chaves e senhas e não nomeia `.env`, chaves e credenciais). O backend o põe na frente da primeira mensagem (uma vez só, e só depois de enviada); a tela esconde o bloco e mostra só a pergunta. Só com a origem em terminal (ou sem nenhuma fala) a pergunta cai no **recorte** que a tela monta (um trecho recente do histórico como contexto citado). Nada disso é silencioso: um aviso no topo da pergunta diz o motivo (`chat.sideChat.portableNote` ou `chat.sideChat.forkNote`). Detalhes e limites em [HARNESS_CONTRATO](HARNESS_CONTRATO.md) (`fork`). O fork nunca altera nem interrompe a sessão da origem: só lê o que ela gravou e abre outro processo, com outra sessão. A pergunta começa com o **modo de permissão da origem** (o Plano da origem vale como Supervisionado), e o seletor da barra só oferece modos até o dela: dá para baixar antes de enviar, nunca passar do da origem (o envio também traz o modo para dentro do teto). Modelo e esforço começam nos da origem e mudam no próprio composer. Não desmonta o PTY, não interrompe o turno da origem e não envia nada pela conversa principal. Perguntas laterais não abrem outras. “Trazer à conversa” preenche o composer de origem sem enviar automaticamente. A lista lateral permite retomar ou remover conversas ociosas sem pedidos pendentes. Ainda não há vínculo persistente para conversas TUI.
- **Painel direito (540 px):**
  - **Diff:** o `git diff HEAD` da pasta, pelo comando `scm_working_diff`, relido quando o agente trabalha;
  - **Arquivos:** o `FilesView`;
  - **Maximizar:** o painel ocupa a área da conversa.
- **Sidebar (prancheta 1):**
  - busca, filtro por pasta, adicionar projeto e nova conversa;
  - cartões com o status ao vivo e o `+/−` da pasta;
  - "Concluídas", com as pastas fechadas para reabrir;
  - rodapé com Configurações, Pull requests (Forge) e Uso (Contas).

## Telas no visual novo

- **Telas cheias dentro da casca:** com o chat ligado, Configurações, Missões, Frota, Squads, Skills, Marketplace, Forge e Histórico abrem no lugar da conversa (`ChatPage`), não por cima (`RouteModal`). As rotas não mudam. Escape ou "Voltar ao chat" voltam à conversa.
- **Configurações (prancheta 5), a mesma tela em todos os modos:** nas Abas e no Canvas a página desenha a barra das seções (`SettingsSidebar`); no chat, a barra é a da casca, com os semáforos e o "Voltar ao chat". A barra tem três grupos, a busca, o selo "Novo" e o número de sugestões de memória pendentes na Memória. A busca acha também pelas abas e pelos ajustes de dentro (`SETTINGS_SEARCH`). A página tem título e subtítulo; as seções usam cartões com borda, linhas de 14 px, chave azul e segmentado. O visual antigo (a barra com ícones coloridos e a coluna de memória à direita) saiu.
- **Seção "Modo chat":** saiu de Avançado e virou seção própria (`chat`).
  - Ao abrir: o liga/desliga e o **modo inicial** (Chat, Abas ou Canvas; `uiStore.startMode`, aplicado na abertura por `startShell` e, para Abas/Canvas, pelo `AppShell` na pasta ativa).
  - Novas conversas: agente e permissões padrão, worktree, Plano e "sem terminal" (os mesmos valores que o composer lembra, `chatPrefs`).
  - Visual: a **largura da conversa** (Normal 736 px, Larga 960 px, Inteira; `chatLook.ts`, ao vivo).
- **Seções novas:** Dispositivos (as preferências do simulador iOS e o Android) e Worktrees.
- **Contas (prancheta 6):** no chat, os agentes em abas; as contas do escolhido num cartão com o estado e as barras de cota (janela atual e semana; cor por faixa em `accounts/meter.ts`); adicionar conta; os pools; e o gerenciador completo (limites, chaves, git) embaixo.
- **Decisões (prancheta 7):** no chat, duas colunas. À esquerda o provedor, a comparação e os pontos com o selo do modo (`POINT_MODE`: Sombra, Ajuda, Sugere, Decide, como na tabela do `docs/agentes/JEV.md`); à direita o resumo do modo sombra (`shadowSummary`) e onde o Jev age.
- **Espaços (prancheta 6):** nas outras telas a sidebar lista Conversas e os Espaços (`chatSpaces.ts`). Memória abre a seção das Configurações.
- **Painel direito (prancheta 8):** o Diff fixo e as superfícies abertas (`useChatStore.surfaces`), cada uma com o nome do que mostra (o host do navegador, o aparelho escolhido); o "+" abre as outras e cada aba fecha no "×". Design e os aparelhos são carregados sob demanda (puxam o canvas):
  - **Design:** o mesmo `DesignPanel` do canvas, com os designs da pasta da conversa;
  - **Simulador iOS (prancheta 9):** uma aba com o nome do aparelho. Em cima, o seletor ("iPhone 18 Pro · iOS 26 simulador"), o estado, o app aberto e "Reabrir app". No meio, a tela nativa (`SimulatorScreen`) numa moldura com as medidas da prancheta (`devicesModel.deviceFrame`). À direita, os controles: Início, Girar, Capturar (a captura vai para o composer como `@caminho`), Aparência, Localização, Face ID, Teclado e o "⋮" (bloquear, abrir URL, modo leve, ligar/desligar).
  - **Android (prancheta 10):** uma aba com o modelo. Em cima, o segmentado dos aparelhos ("Pixel 9 · API 36 · emulador", "Galaxy S25 · USB"), o estado e `adb · serial`. No meio, os quadros do `adb` com toque e deslizar. À direita: Voltar, Início, Recentes, Girar, Capturar, Volume, Logcat e o "⋮" (ligar um AVD).
  - **Chave dos agentes:** "Permitir que agentes controlem dispositivos" (rodapé das duas). Os aparelhos abertos no painel chegam ao `ags device` de qualquer agente (`devices_share`); com a chave desligada, o agente só vê (`shot`/`tree`).

## Conversa por protocolo (caminho B): Codex pelo `app-server`

Com o Codex, a conversa nova fala direto com o agente pelo `codex app-server`, sem TUI. Vale para as conversas novas e pode ser desligado em Configurações → Modo chat → "Codex, Claude Code, OpenCode e Antigravity sem terminal" (a mesma opção liga o Claude Code, o OpenCode e o Antigravity por protocolo, abaixo). Desligado, o Codex roda na TUI como os outros agentes. As conversas que já existem não mudam.

- **Backend (`src-tauri/src/conversa/`):**
  - `store.rs`: as tabelas `chat_thread`, `chat_run`, `chat_item` e `chat_request`. A migração é só aditiva, sem subir `user_version`.
  - `codex.rs`: um processo `codex app-server` por conversa, com JSON por linha no stdio e MCP `ags` configurado com overrides `-c` apenas nesse processo. Ele sobe na primeira mensagem e retoma a thread do Codex (`thread/resume`) depois de reabrir o app.
  - `codex_map.rs` (puro): os itens do Codex viram o mesmo `canal::timeline::Item` da timeline lida do transcript; o acesso vira política de aprovação e sandbox.
  - `commands.rs`: `chat_threads`, `chat_thread_create`, `chat_thread_send` (começa um turno ou entra no que está em andamento com `turn/steer`), `chat_thread_items`, `chat_thread_requests`, `chat_thread_status`, `chat_thread_interrupt`, `chat_request_answer`, `chat_thread_retune`, `chat_thread_rename` e `chat_thread_settle`.
  - Evento `cc-chat-thread`, com os tipos `item`, `delta`, `phase`, `request`, `requestResolved`, `thread`, `error` e `closed`.
- **Acesso:**

  | No chat | `approvalPolicy` | Sandbox |
  |---|---|---|
  | Supervisionado | `untrusted` | `workspace-write` |
  | Auto | `on-request` | `workspace-write` |
  | Acesso total | `never` | `danger-full-access` |

  Trocar o acesso fecha o processo; a próxima mensagem retoma a thread com o sandbox novo. Modelo e esforço valem no próximo turno.
- **Front (`src/features/chat/structured/`):** o store ao vivo, os cartões (chave `thread:<id>`) e a `StructuredConversationView`. A tela usa a mesma `TimelineView`, o mesmo composer e os mesmos menus da conversa por TUI. Aprovações e perguntas se respondem nos botões do composer; parar interrompe o turno.
- **CLI e MCP:** `ags chat list|new|send|wait|show|stop|pending|open|settle` e as tools `chat_*` nas abas. Codex, Claude Code e OpenCode por protocolo também recebem o MCP local da ADE, escopado à pasta e à conversa; podem consultar `agent_roster` e delegar trabalho separável com `run_plan` ao scheduler da frota. Antigravity em `agy --print` recebe o MCP por configuração temporária em cada turno (não há uma sessão interativa persistente) e também pode delegar. O worker/modelo pode ser escolhido entre os disponíveis no roster, ou roteado pela ADE por complexidade. Essa integração não altera configuração global do provider nem cria um segundo scheduler. No Antigravity, tools que exigiriam aprovação interativa só podem executar em Acesso total.
  - Uma conversa aberta por agente começa **supervisionada** (`access: ask`).
  - `chat wait` dorme no barramento (`chat.changed`), sem polling, até o turno acabar ou o agente pedir algo à pessoa. `reply` é a última fala DEPOIS da última mensagem da pessoa; terminou sem fala nova (erro, interrompido, processo caído), `reply` vem `null` e `stopped` traz o motivo (lido do `turnEnd`).
  - Responder às aprovações e perguntas do agente da conversa **não** tem comando: é da pessoa, na tela.
  - `chat open` liga a casca do chat e mostra a conversa (pela ponte do front, `cliBridge.ts`).
  - Papéis só de leitura (QA) recebem só `chat_list`, `chat_show`, `chat_wait` e `chat_pending`; tarefas da frota não recebem as tools do chat.

### Claude Code por protocolo

Com o Claude Code, a conversa nova fala com o agente por `claude -p` em stream-json, sem TUI. A opção é a mesma do Codex ("Codex, Claude Code, OpenCode e Antigravity sem terminal").

- **Protocolo (Claude Code 2.1.312, conferido no `--help`, no binário e em 2 turnos reais mínimos):** um processo por conversa, com `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio --permission-mode <modo>`, e `--model`/`--effort` quando escolhidos. É o mesmo protocolo que o Agent SDK usa: JSON por linha nos dois sentidos.
  - **Sessão:** a primeira abre com `--session-id <uuid>` escolhido pelo app; depois de fechar (reabrir o app, trocar o acesso), a próxima mensagem retoma com `--resume <uuid>`. Um `--resume` de sessão que sumiu fecha o processo antes de responder ao `initialize`: aí abre uma sessão nova, e a timeline guardada continua.
  - **Mensagens:** o app manda `{type: "user", message}`; o Claude devolve `assistant` (um bloco por linha, com o mesmo `message.id`), `user` (os `tool_result`), `stream_event` (os pedaços do texto, com `api_message_id` e `index`) e `result` (o fim do turno). O texto em pedaços e o item final têm o mesmo id (`<message.id>#<index>`).
  - **Aprovações:** com `--permission-prompt-tool stdio`, o Claude manda o `control_request` `can_use_tool` e espera `{behavior: "allow" | "deny"}`. "Permitir na sessão" devolve as sugestões do próprio Claude (`permission_suggestions`), sempre com `destination: "session"`: nada vai para os settings do projeto. `AskUserQuestion` chega pelo mesmo pedido e responde com `updatedInput.answers`.
  - **Parar:** o `control_request` `interrupt`. O turno acaba com `result` (`terminal_reason: "aborted_*"`) e vira fim de turno interrompido.
  - **Aprovações não passam pela tool da frota** (`--permission-prompt-tool mcp__ags__approve_tool_use`): o Claude continua usando `--permission-prompt-tool stdio`, e o pedido chega à conversa por `control_request` para a pessoa responder na tela. O MCP `ags` adicional serve ferramentas locais de navegação, dispositivos, Git e orquestração; `run_plan` continua sujeito à política de autorização existente.
- **Acesso** (`--permission-mode`):

  | No chat | Modo do Claude |
  |---|---|
  | Supervisionado | `default` (pede aprovação de tudo que não é leitura) |
  | Aceitar edições | `acceptEdits` |
  | Auto | `auto`, o mesmo nível seguro das missões (`withAutonomy`) |
  | Acesso total | `bypassPermissions` |
  | Plano | `plan` |

  - O **Plano** fica guardado no próprio `access` da conversa (`plan`, só no Claude), sem coluna nova. Ele liga e desliga no botão Plano/Construir do composer; desligar volta a Supervisionado, nunca a um modo com mais permissão.
  - Sair do Plano é o pedido `ExitPlanMode`, com o plano no detalhe: "Aprovar o plano" segue em Supervisionado, "Aprovar e aceitar edições" segue em `acceptEdits`, "Continuar planejando" nega e o agente ajusta o plano.
  - Quando o modo muda do lado do Claude (saiu do Plano, aceitou edições na sessão), o `access` da conversa acompanha e a tela recebe o evento `thread` com o `access` novo.
  - Trocar modelo, esforço ou acesso fecha o processo (no fim do turno, se há um); a próxima mensagem retoma a sessão com as flags novas.
- **Backend:** `conversa/claude.rs` (o processo, com o mesmo evento `cc-chat-thread` do Codex) e `conversa/claude_map.rs` (puro: linhas em itens, `can_use_tool` em pedido, respostas, flags). O `api.rs` escolhe o motor pelo agente da conversa (`Engine::Codex` / `Engine::Claude`). As ferramentas viram itens pelo mesmo `canal::timeline::claude_tool` da timeline lida do transcript; o `ExitPlanMode` vira o plano.
- **Conta:** `accounts::env_for_account` (o `CLAUDE_CONFIG_DIR` da conta), como no Codex.

- **Ainda não:** ACP do Gemini e do Kimi; reverter turno; anexos de imagem; o detalhe interno das tarefas de subagentes `Task` nativos do Claude. A delegação entre provedores da ADE já pode ser feita via `agent_roster`/`run_plan` em conversas Codex, Claude Code e OpenCode, sem depender dos subagentes nativos de cada CLI.

### OpenCode por protocolo (ACP)

Com o OpenCode, a conversa nova fala por `opencode acp` (Agent Client Protocol: JSON-RPC 2.0 por linha no stdio), um processo por conversa. É o mesmo desenho do Codex e do Claude Code, em `conversa/opencode.rs` (processo) e `conversa/opencode_map.rs` (puro).

- **Por que o ACP** (e não `opencode serve` ou `opencode run --format json`): é um protocolo bidirecional por stdio, como o `codex app-server`, sem porta nem servidor compartilhado; o `run --format json` é um processo por turno, sem permissão nem texto em pedaços (o fixture `runs/fixtures/opencode_stream.jsonl` só tem partes inteiras).
- **Conferido sem gastar cota** (OpenCode 2.2.1): `initialize` e `session/new` reais. Eles mostram `loadSession`, `sessionCapabilities.resume`, `configOptions` (`model` com `provedor/modelo`, `effort` que muda com o modelo, `mode` com `build` e `plan`) e que o `OPENCODE_CONFIG_CONTENT` do ambiente vale para o `acp` (o modelo da config aparece no `session/new`). **Não conferido:** um turno real (texto, ferramentas, permissões); esses avisos seguem a especificação do ACP e estão no teste `e2e_opencode_acp_um_turno_real` (`#[ignore]`, `CC_E2E_OPENCODE_MODEL`).
- A config passada ao ACP mescla o servidor MCP `ags` da ADE à política de acesso temporária já usada pelo chat, sem substituir o MCP do usuário gravado em arquivo. O processo recebe o escopo `thread:<id>`.
- **Sessão:** `session/new` na primeira mensagem; depois de reabrir o app, `session/resume` (sem reenviar o histórico), com `session/load` de reserva (os avisos de replay são ignorados) e, se a sessão sumiu, uma nova (a timeline guardada continua). O id vai em `chat_thread.remote_id`.
- **Mensagem e fila:** `session/prompt` responde só no fim (`stopReason`). O ACP não tem "entrar no turno": a mensagem que chega com o turno em andamento fica numa fila e começa o turno seguinte.
- **Parar:** o aviso `session/cancel`; os pedidos de permissão em aberto respondem "cancelado".
- **Itens:** `agent_message_chunk` e `agent_thought_chunk` viram os `delta` do fluido e os itens `assistant`/`reasoning` (o texto fecha quando chega outra coisa); `tool_call`/`tool_call_update` viram a ferramenta equivalente do Claude (`execute` → comando, `edit` com `diff` → edição com `+/−`, `read`, `search`, `fetch`, `think` → subagente); `plan` vira o plano do turno; `usage` da resposta vira os tokens.
- **Aprovação:** o `session/request_permission` vira uma linha de `chat_request` (as opções do protocolo ficam em `options.acp`). Permitir → `allow_once`; "Sempre nesta sessão" → `allow_always` (cai em `allow_once` se o OpenCode não oferece); Recusar → `reject_once`. Nunca dá mais permissão do que a pedida.
- **Acesso:** o OpenCode não tem aprovação por flag; o acesso vira a política `permission` da configuração dele, passada em `OPENCODE_CONFIG_CONTENT` na abertura do processo:

  | No chat | `edit` | `bash` | `webfetch` | Modo |
  |---|---|---|---|---|
  | Supervisionado | ask | ask | ask | build |
  | Aceitar edições | allow | ask | ask | build |
  | Auto | allow | ask | allow | build |
  | Acesso total | allow | allow | allow | build |
  | Plano | ask | ask | ask | plan (read-only) |

  O OpenCode não tem sandbox nem classificador, então o "Auto" aqui é: edita e busca na web sozinho; comando ainda pergunta.
- **Modelo e esforço:** `session/set_config_option` na abertura (o modelo antes, porque o esforço depende dele). Um modelo que o OpenCode não lista dá erro claro; um esforço que o modelo não tem fica no padrão. Trocar modelo, esforço ou acesso fecha o processo (no fim do turno) e a próxima mensagem retoma a sessão.

### Cursor por protocolo (`cursor-agent -p` em stream-json)

Com o Cursor, a conversa roda `cursor-agent -p --output-format stream-json --stream-partial-output --trust --workspace <pasta>`,
**um processo por turno** (`conversa/cursor.rs` e `conversa/cursor_map.rs`), continuando com `--resume <session_id>` (o id vem
do `system/init` e fica em `chat_thread.remote_id`). O executável é achado pela mesma resolução do app (`util::find_program`:
PATH do shell de login e a pasta do instalador do Cursor).

- **Conferido só pela doc oficial** (`cursor.com/docs/cli/reference/output-format`), com fixtures dos exemplos dela nos testes
  (`test_motores.rs::cursor`). **Nenhum turno real foi feito** (cota): os nomes das ferramentas além de `read`/`write`, o evento
  `thinking` e o desfecho de uma ação recusada são lidos de forma tolerante (o que não conheço vira ferramenta genérica).
- **Fala.** Com `--stream-partial-output`, os pedaços são os `assistant` COM `timestamp_ms` e SEM `model_call_id`; os outros
  repetem o texto e são ignorados. A ferramenta (`tool_call` started/completed) fecha a fala antes dela, na ordem do fio.
- **Acesso.** `ask`: sem flag; no `-p` o que mudaria arquivos ou rodaria comandos não é aplicado (a mesma advertência
  `noApproval` do Antigravity). `plan`: `--mode plan`. `full`: `--force`. Aceitar edições e Auto não têm flag documentada:
  o motor não os aceita (`Engine::accepts`), e a troca de agente os converte para Supervisionado dizendo isso.
- **Modelo e esforço.** O modelo é o id da variante de `cursor-agent --list-models`; o esforço faz parte dele (`…-high`), por
  isso o controle de esforço fica escondido. Sem conta por conversa (login único do `cursor-agent login`) e sem ai-memory.
- **Limites.** O fluxo não traz tokens nem cota: o cartão de Limites mostra «não medido · sem fonte de cota».
- **Fim do turno.** O turno fecha no `result`, sem esperar o processo sair: um servidor que o agente deixou em segundo plano
  (o Metro de um `npx expo start`) mantém o `cursor-agent` vivo, e o EOF nunca chega. Isso deixou uma conversa 9 h em
  «Pensando…», com a resposta só na janela e a fila presa. O processo ganha 3 s para sair e então é encerrado. O que ele
  deixou rodando não é tocado. Sem `result` e sem EOF, vale o **prazo de silêncio** (`cursor_map::quiet_after`):
  - **10 s depois do `usage` de uma chamada do modelo que não pediu ferramenta:** o turno acaba bem. No `-p`, o
    `cursor-agent` só manda o `result` quando os shells que ele pôs em segundo plano acabam, e um `npx expo start`
    nunca acaba. A conversa ficava uns 3 min em «Pensando…» depois de cada resposta, quase sempre uma pergunta à
    pessoa (a pergunta não era a causa: era o fim da resposta). Qualquer sinal nesses 10 s desfaz o fim;
  - **3 min depois da fala, sem ferramenta aberta:** o turno acaba bem, porque a resposta veio;
  - **15 min sem sinal:** o turno fecha com erro;
  - **ferramenta rodando:** sem prazo, porque um build longo é legítimo.

  Um servidor que o agente deixou em segundo plano morre quando o turno fecha e o `cursor-agent` é encerrado. Para
  um servidor que precisa ficar de pé, como o Metro, use o terminal da conversa (o `>_`).
  As perguntas do agente à pessoa (`interaction_query`) não travam: o `cursor-agent -p` as recusa sozinho.
- **Parar sem agente vivo** (todos os motores, `api::stop`, também `ags chat stop`): fecha no banco o turno que ficou aberto
  daquela conversa, com o fim «o agente já não estava rodando», e a janela volta a ociosa. Antes, o Parar não fazia nada.
- **Parar do Claude e do OpenCode durante a abertura do turno** (`codex_parar.rs`, o mesmo guarda): a mensagem já saiu, mas o agente ainda não mostrou que o turno roda. O Parar fica pendente e sai no primeiro aviso do turno (`system/status`, `stream_event`, `assistant` ou `user` no Claude; `session/update` de conteúdo no OpenCode); o fim do turno ou um envio que não saiu o descartam. Enquanto isso, o Parar não fecha no banco o turno que está abrindo (`api::close_idle_orphans`). A resposta do recibo é `deferred`, como no Codex (contrato §11.13).
- **Parar do Codex antes do `turn/started`** (`codex_parar.rs`): o app-server só aceita `turn/interrupt` depois do aviso e antes recusa com `-32600`, então o turno seguia rodando e o Parar sumia. Agora o Parar recebido entre o `turn/start` e o `turn/started` fica **pendente na sessão** e sai quando o aviso chega; se o turno acaba antes (ou o `turn/start` falha), a pendência é descartada. Sem turno aberto nem `turn/start` a caminho, o Parar cai no fechamento do turno órfão acima.

### Antigravity por protocolo (`agy --print` em stream-json)

Com o Antigravity, a conversa nova roda `agy --print <mensagem> --output-format stream-json`, **um processo por turno** (`conversa/agy.rs` e `conversa/agy_map.rs`).

- **Por que um processo por turno:** o `agy` tem `--input-format stream-json` (vários turnos num processo), mas o formato das mensagens de entrada (`{"event": …}`) não está documentado e eu não quis adivinhá-lo. Com `--conversation <id>` o `-p` continua a mesma conversa (o `conversation_id` vem do `init` e do `result` e fica em `remote_id`), então a conversa se comporta igual; só não há processo vivo entre os turnos. Não há ACP no `agy`.
- **Conferido sem gastar cota** (agy 1.4.11): `--help`, o changelog embutido, o `-p "/usage"` (o CLI responde sozinho: confirma o envelope `{"event": …}` e o `result` com `usage`) e o parser que as tarefas já usam (`runs/antigravity.rs`: `step_update` com `step_index`, `state`, `step_type`, `text_delta`, `tool_name`, `parameters`). **Não conferido:** um turno real; os campos das ferramentas (`tool_info`, `parameters`) vêm do changelog, e o mapeamento é tolerante a nomes que não conheço (vira uma ferramenta genérica com o nome). Teste `e2e_agy_um_turno_real` (`#[ignore]`, `CC_E2E_AGY=1`).
- **Itens:** `step_type: agent_response` com `text_delta` vira os `delta` e a fala; passos de pensamento viram `reasoning`; os outros viram ferramentas (`run_command` → comando, `view_file` → leitura, `edit_file`/`write_to_file` → edição, `grep_search` → busca, `read_url_content` → web, `call_mcp_tool` → "servidor: ferramenta"); o `usage` do `result` vira os tokens; `finished_reason` (`interrupted`, `print_timeout`, `error`) decide o fim do turno.
- **Sem aprovação:** no modo `-p` o agy não pergunta. O que precisaria de aprovação é negado e vem em `denied_actions`, que a conversa mostra como ferramentas negadas. Por isso esta conversa **nunca gera pedidos de aprovação**.
- **Acesso:** Supervisionado = nenhuma flag (o que pede aprovação é negado, então é quase só leitura); Aceitar edições = `--mode accept-edits`; Auto = `--mode auto`; Plano = `--mode plan`; Acesso total = `--dangerously-skip-permissions`. As barras da mensagem não viram comandos do CLI (`--disable-slash-commands`).
- **Modelo e esforço:** `--model` (os ids de `agy models`) e `--effort`; valem no turno seguinte, sem fechar nada.
- **Fila e parar:** a mensagem que chega com o turno em andamento fica na fila; parar mata o processo do turno.

## Texto chegando e tipografia

- **Por protocolo, os pedaços reais.** O evento `delta` do `cc-chat-thread` leva `itemId`, `delta` e `kind` (`assistant` ou `reasoning`) e vai só à janela: o banco grava o item completo, como antes.
  - **Codex:** `item/agentMessage/delta` (a resposta) e `item/reasoning/summaryTextDelta` (o resumo do raciocínio); `item/reasoning/summaryPartAdded` com índice > 0 vira a linha em branco entre as partes, como no item final. O `item/reasoning/textDelta` (raciocínio cru) fica de fora. Mapeamento puro em `codex_map::delta_of`.
  - **Claude Code:** com `--include-partial-messages`, os `stream_event` `content_block_delta` de `text_delta` e `thinking_delta`, com o id do bloco (`api_message_id` + `index`), o mesmo do item final (`claude_map::delta_of`). O CLI já junta pedaços seguidos do mesmo bloco antes de mandar, então chegam em rajadas.
  - **Na janela:** os pedaços de um quadro viram uma atualização só do store (`createFrameBatcher` com `requestAnimationFrame`); qualquer outro evento entrega os pendentes antes, para manter a ordem. Os rascunhos ficam por item (`ThreadLive.drafts`) e entram na timeline como itens comuns (`withDrafts`); o raciocínio chegando alimenta a linha viva.
- **Revelar (`timeline/streaming.ts`, `useRevealedText`):** a fala do agente que chegou depois de abrir a conversa aparece palavra a palavra, a ~160 caracteres por segundo, acelerando para nunca levar mais de 1,5 s pelo que falta. Vale para os rascunhos do protocolo e para as mensagens inteiras do transcript (TUI). O histórico (o que estava na primeira leitura, ou com carimbo de mais de 10 s antes de abrir) aparece inteiro. O progresso fica por id, então o rascunho que vira item final continua de onde parou. Com `prefers-reduced-motion`, aparece tudo de uma vez.
  - **TUI:** o transcript do Claude Code e do Codex só grava o bloco inteiro; hooks e statusline não trazem o texto parcial. Por isso a TUI usa só o revelar.
- **Cursor e rolagem:** enquanto o texto chega ou aparece, um cursor discreto no fim (`cc-stream-caret`, sem piscar com movimento reduzido). A rolagem acompanha o tamanho do conteúdo (`ResizeObserver`) se a pessoa estava no fim.
- **Tipografia (a escala do app do Claude):** a raiz da casca leva `cc-chat-type`, que troca a família (a pilha de reserva do Claude; a Anthropic Sans é proprietária e não vem junto) e os pesos (semibold 580, bold 600). Os tamanhos são tokens do `@theme` (`text-chat-prose` 16/24, `text-chat-ui` 14/20, `text-chat-heading` 15/20, `text-chat-title` 22/28, `text-chat-code` 13/19, `text-chat-note` 13/17, `text-chat-caption` 12/16). A fala do agente usa o `Markdown` com `tone="chat"`. As telas que também aparecem nas Abas (Configurações, a barra das seções, o botão Chat da barra de abas) mantêm os tamanhos; dentro da casca herdam só a família e os pesos.

## Agente trabalhando e permissões (pranchetas 13 e 14)

- **Linha viva** acima do composer (`LiveActivity.tsx`, lógica pura em `activityModel.ts`): três pontos de 5 px (pulso de 1,2 s; parados com `prefers-reduced-motion`), «Trabalhando…», o tempo e os tokens do turno e "Ver o que está fazendo" (os dois últimos comandos e o raciocínio mais recente). Não repete o comando nem o «Pensando…»: os dois já estão na timeline logo acima (o comando cortado no meio e as duas linhas empilhadas confundiam). A sidebar continua com a atividade ("Rodando testes"). `role="status"`; o tempo fica fora do anúncio.
  - **De onde vem:** os itens da conversa. A timeline ganhou os itens `reasoning` (o `thinking` do Claude, o `agent_reasoning`/resumo do Codex) e `usage` (os tokens de cada chamada: no Claude, entrada + cache + saída por mensagem; no Codex, o `token_count` do transcript ou o `thread/tokenUsage/updated` do app-server, com a base do turno em `codex_map::TurnTokens`), e o campo `plan` nas ferramentas `todo` (TodoWrite, `update_plan`, `turn/plan/updated`). Nada disso aparece no fio; `ags chat show` não lista os `usage`.
  - **Sidebar e cabeçalho:** a TUI usa o estado do canal (`turnStartedAt` e a ferramenta pendente, em `liveStore.turn`), sem ler a timeline de cada aba; a conversa por protocolo, os itens que chegam pelo evento.
- **Plano do turno** (`PlanCard`): "Plano · 2 de 4", o passo atual em destaque e os concluídos riscados, logo abaixo da mensagem do turno em aberto.
- **Enviar agora e fila:** com o agente trabalhando, a dica do composer diz o que o ⏎ faz naquele motor (`PROTOCOL_AGENTS.midTurn`, `chatModel.ts`):
  - **Codex e Claude (`steer`):** «⏎ manda agora, no meio do turno». O Codex recebe `turn/steer`; o Claude lê a mensagem do stdin no meio do turno ou logo depois dele. Nada para;
  - **Cursor, Antigravity e OpenCode (`interrupt`):** «⏎ para o turno e manda». Esses motores não aceitam entrada no meio do turno: antes, a mensagem esperava numa fila do backend, atrás de um turno que podia não acabar (o Cursor com o Metro em segundo plano), e o Parar a descartava. Agora `queueRunner.sendNow` a põe na frente da fila do composer, para o turno, e ela sai assim que ele parar, como o próximo turno da mesma sessão (o que já foi feito fica);
  - **⌘⏎ (Ctrl+⏎ fora do macOS)** põe na fila, e o `queueRunner` manda a próxima quando o turno acaba (TUI: quando o canal diz ociosa), uma por turno; um pedido esperando a pessoa segura a fila.
  - As mensagens esperando aparecem acima da caixa (`QueueList`): «Na fila» ou «Vai assim que o turno parar», com o texto, **Editar** (sai da fila e volta para a caixa) e **Tirar**. Na TUI, o ⏎ vai ao terminal do agente, que decide sozinho.
- **Composer em coluna estreita** (o painel do simulador aberto): a coluna do composer é o container `composer` (`ComposerColumn`). A linha de baixo não quebra: o nome do modelo trunca só quando falta espaço; abaixo de 30rem, «Construir»/«Plano» fica só com o ícone; abaixo de 28rem, a pasta («Checkout atual») e o acesso também (o rótulo vai no tooltip e no leitor de tela), e só aí a linha volta a quebrar, para nada passar da borda do cartão.
- **Permissões, um store só** (`permissions/`): as aprovações das conversas por protocolo (`chat_request`), os diálogos das TUIs (`terminalPrompts`, lidos de todas as abas de agente pelo `PermissionsManager`) e as aprovações da frota (`runs`) viram o mesmo `PendingAsk` (`askSources.ts`), com agente, conversa, tipo (comando, edição, rede), detalhe, pasta, risco e o que mexe. Responder usa o caminho de cada fonte (`chat_request_answer`, `answerTerminalPrompt`, `decideApproval`).
  - **Risco** (`riskOf`, puro): leitura é baixo; instalar e o resto é médio; `git push`, `rm -r`, `sudo`, publicar, `--force` são altos. Edição dentro da pasta é baixo; fora ou em arquivo sensível, médio; sensível fora, alto.
  - **Cartão no fio:** Negar (N), Responder… (nega e manda o texto ao agente), "Sempre permitir <padrão>" e Permitir (⏎). Substitui os botões de aprovação do composer; perguntas e a saída do Plano seguem no composer.
  - **Caixa "Permissões"** (⇧⌘A, ou Ctrl+Shift+A; e o aviso "N agentes esperando você" na sidebar): filtros com contagens, J/K, Permitir/Negar, Abrir conversa, Negar todos e Permitir os de baixo risco. Divide o lado direito com o painel: abrir um fecha o outro.
  - **Regras "Sempre permitir":** nos settings (`chat.permissions.rules`, sem tabela nova), por tipo, padrão e agente; editáveis em Configurações → Permissões. Um comando composto só casa se todas as partes casarem; risco alto nunca é automático.
  - **Aviso do sistema:** pedido novo com o app sem foco vai pelo `chat_permission_notify` (o `notifier::show_custom` das missões, com `notifications.enabled`). A frota segue com o aviso dela.

## Time de agentes (pranchetas 15 e 16)

- **O modelo:** uma conversa (aba de TUI ou conversa por protocolo) vira o **Orquestrador** de um time; os integrantes são outras conversas (novas ou já abertas), cada uma com papel (UI, Backend, Testes, Revisor…), modelo, política (Acesso total, Aceita edições, Supervisionado/"Pede tudo", Só leitura) e, quando o time a abriu, um worktree na branch `team/<papel>`. Um agente está em um time só.
- **Backend (`src-tauri/src/chat_team/`):** as tabelas `chat_team` e `chat_team_member` (só aditivas, criadas sob demanda, sem subir `user_version`); `api.rs` (criar, ligar, desligar, papel, política, o fio); os comandos `chat_team_*` e o evento `cc-chat-team`. O chat da equipe e as entregas de um time usam o escopo `t:<id>` (`missions::messages::scope_of`).
- **O canvas é a autorização:** ligar alguém faz a tela pôr a coroa no orquestrador, a corda até o integrante e o papel no nó (`team/teamCanvas.ts`), como numa missão; abas do time vão para o canvas do orquestrador. Uma conversa por protocolo não tem nó: a corda dela (`thread:<id>`) fica no canvas da pasta e o `reconcile` a mantém.
- **Mensagens:** `ags peer tell/ask/deliver` alcançam as conversas por protocolo do time (`ipc/commands/team.rs`): a mensagem entra na mesma fila (`peer_messages`) e vai como mensagem da conversa, depois do turno em andamento. O processo da conversa recebe `ADE_TAB_ID=thread:<id>` e o `ags` no PATH, para responder.
- **CLI e MCP:** `ags team list|create|link|unlink|role` e as tools `team_*`. Só o orquestrador liga, e só conversas da pasta dele; o agente nunca aumenta a política de ninguém (no máximo `ask`); desfazer o time é da pessoa.
- **Tela (`src/features/chat/team/`):** o painel Time (`TeamPanel`, a aba "Time" do painel direito) com o formulário de ligar e o arrastar da sidebar; os cartões de delegação e as entregas no fio do orquestrador (`TeamThreadFeed`); o segmentado "Time | Só o orquestrador" e o @agente (`TeamComposer`); o grupo do time na sidebar (`TeamSidebar`); o selo "Orquestrador · X" (`TeamHeaderBadge`).
- **Onde aparece:** a aba "Time" do painel direito abre sozinha ao abrir uma conversa que está num time (uma vez por conversa); a sidebar agrupa os integrantes sob o orquestrador com o selo "TIME · N"; o cabeçalho mostra "Orquestrador · X"; o composer do orquestrador tem "Time | Só o orquestrador" à esquerda e o menu do @agente; o fio termina com os cartões das delegações e o resumo das entregas.
- **Permissões:** `team/teamPermissions.ts` diz de quem é o pedido (papel, política, time) e o que a política decide sozinha. O `PermissionsManager` aplica a política antes das regras "Sempre permitir": só leitura nega (e diz ao agente por quê), o que a política deixa passa sozinho, o resto vai às regras e à pessoa; risco alto nunca é automático. O cartão e a caixa mostram o papel e a política (`TeamRoleTag`).

### Time único: origem, promoção do canvas e coroa tirada (E2 da unificação)

O roster do chat (`chat_team` + `chat_team_member`) é a fonte única do time, qualquer que seja o modo onde ele nasceu. Colunas aditivas em `chat_team` (protegidas por `store::has_column`, sem subir `user_version`; linhas antigas ficam `origin = 'chat'`):

- `origin`: `chat` (montado no chat), `canvas` (promovido de uma coroa com cordados) ou `mission` (linha-espelho de uma missão, a E5; o motor da missão não se funde ao roster);
- `board_key`: onde mora a coroa no canvas (pasta ou `#c:`);
- `mission_id`: só `origin = 'mission'`.

Comandos (em `chat_team/commands.rs`, funções puras em `api.rs`):

| Comando | O que faz |
|---|---|
| `chat_team_promote` | Cria o time a partir de uma coroa do canvas e dos cordados (`origin = 'canvas'`). **Só grava linhas**: não abre processo, PTY nem worktree. Idempotente. Quem já é de outro time ou de uma missão volta em `skipped`. Recusa o quadro `#m:`. |
| `chat_team_unlead` | A coroa saiu do canvas: tira **só o papel de orquestrador**. O time, os integrantes, as regras e o histórico ficam. Idempotente. |
| `chat_team_lead` | Dá um orquestrador a um time que ficou sem (ou troca o dele). Se ele era integrante do mesmo time, deixa de ser. |
| `chat_team_rebind(old_ref, new_ref)` | Troca a ref (aba ↔ `thread:<id>`) no roster **e nas cordas** do `canvas.json` (nó, cordas, coroa, papel, subagente). Só o endereço: quem converte (fecha uma, abre a outra) é quem chama (E6). |

Um time sem orquestrador tem `orchestrator = ""` para fora (a coluna é `NOT NULL UNIQUE`; por dentro guarda `none:<id do time>`). Ele continua com integrantes, escopo `t:<id>` e aceita ligar mais gente; o vigia do chat o pula (não há a quem avisar). Promover uma coroa sobre integrantes de um time sem orquestrador (ou coroar um dos próprios integrantes) faz a coroa **assumir esse time** em vez de criar outro. O invariante "um agente, um time" vale em todos os caminhos e também contra integrantes de missão (quadros `#m:` e linhas `origin = 'mission'`).

`ags team list` mostra `origin`, `boardKey`, `missionId` e `led`. O evento `cc-chat-team` sai em todas as mudanças. O front (E3) é quem decide **quando** promover (só quando a pessoa mexe, nunca no boot) e quem reaplica o canvas depois de `rebind`/`unlead`.

### O time nas Abas (E4 da unificação)

- A vista de Abas lê o **modelo único** (`chat/unified`, `useConversations()`): a grade do time (`canvas/gridMode.ts`, `useMissionGrid`) e o `placementsFrom` usam `tabs/teamTabs.ts` (puro: `teamGroups`, `teamGridRefs`, `terminalRefs`, `teamMenuActions`). O time montado no chat, no canvas ou por missão aparece igual, com a mesma ref e o mesmo papel.
- **Selo de origem** (`chat`, `canvas`, `missão`) na marca do time (`TeamTabMarks`), na aba e na grade.
- **Protocolo**: todo agente novo nasce com terminal. Quem já nasceu por protocolo (`thread:<id>`) não tem aba: entra na grade como painel de timeline (`tabs/ProtocolPane.tsx`, o mesmo `TimelineView` do chat, React puro, só leitura, com o selo "protocolo") e como entrada na barra (`TeamTabsGroup`, que abre a timeline numa gaveta). `placementsFrom` só posiciona terminais (`terminalRefs`): a ref de protocolo nunca vira placement.
- **Ações do time** no menu da aba e no botão "Criar time" da barra, sem lógica nova: `makeOrchestrator`, `linkExisting`, `unlinkMember` e, novos, `chat/team/teamLead.ts` (`leadTeam`/`unleadTeam` sobre `chat_team_lead`/`chat_team_unlead`; tirar a coroa tira só o papel, o time fica).
- Nada muda a `key`, o pai ou o ponto de montagem dos terminais: a grade só desenha huecos e painéis React.

### Espelho canvas → chat (E3 da unificação)

O front (`chat/team/teamMirror.ts`, `teamStore.ts`) decide **quando** o canvas vira time. Tudo puro em `teamMirror.ts`, executado dentro do `runMirror` (debounce de 300 ms; `syncing` impede reagir ao que o próprio time escreveu):

- **Promover (`promotePlan(boards, teams, agents, { only })`).** Uma coroa de canvas de pasta ou `#c:` (nunca `#m:` nem `#cmp:`) que não lidera time, não é integrante de time com orquestrador nem de missão, e tem ao menos uma corda a um agente (aba de agente ou conversa por protocolo) vira time via `chat_team_promote` (`origin = 'canvas'`, papel e subagente lidos do quadro). **Só quando a pessoa mexe:** o observador do canvas marca só os canvases que **ganharam** uma coroa ou uma corda (reconciliar com as abas só tira, e o canvas lido do disco no boot é ignorado), e o plano olha só esses. Nada de backfill ao abrir o app: um canvas antigo é promovido quando a pessoa coroa ou liga algo nele. Mover um nó não conta.
- **Promover nunca lança processo.** Só linhas no banco (`chat_team_promote`); não abre aba, PTY, conversa nem worktree, e não abre o painel Time. A linha de base do time novo nasce adotada (`adoptBaseline`), então o canvas não é reescrito. Há teste que conta os comandos de spawn (`teamPromoteStore.test.ts`).
- **Coroa tirada.** Se o time tinha linha de base, a coroa não está em canvas nenhum e a conversa do orquestrador segue aberta, `reversePlan` emite `unlead` (`chat_team_unlead`): sai só o papel de orquestrador; o time, os integrantes e as cordas ficam. Fechar a aba leva a coroa junto (`reconcile`) e **não** é gesto da pessoa. `canvasPlan` não faz nada num time sem orquestrador (não coroa `""`). Coroar de novo um integrante (ou o antigo orquestrador com as mesmas cordas) faz a coroa assumir o time sem orquestrador.
- **Um time só, com missão.** `reversePlan` e `promotePlan` também deixam de fora quem está num canvas `#m:` (`missionRefsOf`, espelho de `canvas::mission_refs`).
- **Idempotência.** Teste: promover e depois `canvasPlan`, `reversePlan` e `promotePlan` devolvem lista vazia.

Conversa por protocolo no canvas (D3, `Board.threads`): **feita em "A conversa segue o modo" (abaixo).** O corte da E3 foi um engano: as conversas do usuário no chat SÃO por protocolo, então o cartão é essencial.

### Missão no chat, nas abas e no canvas (E5)

A missão **continua dona do motor** (worktrees, entrega, orçamento, `confirm_spend`, Vigia do front, chat da equipe `m:<id>`); o chat só a **mostra** e a **dispara**.

- **Espelho:** ao iniciar o time em terminais (`startMissionInTerminals`, depois de `mission_start_terminals` e do canvas `#m:`), o front chama `chat_team_mission_mirror` e grava uma linha `origin = 'mission'` (`mission_id`, `board_key = #m:`) com o lead como orquestrador e os integrantes que são abas. **Só linhas no banco**; regravar troca o roster da mesma missão; quem já é de um time do chat fica de fora (`skipped`). Sem terminal de orquestrador (Gemini Desktop) não há espelho. A linha sai com `chat_team_mission_unmirror` quando a missão fecha (`done`, `done_without_delivery`, `cancelled`, `failed`: varredura em `missions/watcher.ts` via `mirror.ts::staleMirrors`). Não fecha agente nenhum.
- **O espelho é invisível ao comportamento do chat:** `store::team_of` (escopo do chat da equipe, política, alias de peer, `ags team list` de quem chama) ignora `origin = 'mission'`; só `team_of_any` (o invariante "um agente, um time", `rebind`) o enxerga. O vigia do chat o pula (`watch_db.rs`): **um time nunca tem os dois vigias**. No front, o espelho fica em `useTeamStore.missionTeams`, **fora de `teams`**: não entra em canvas, política nem composer.
- **Sidebar (chat, Abas e Canvas):** os terminais da missão voltam à lista de conversas (antes `AppSessionsSidebar` os escondia com `missionOf`) e o espelho os agrupa sob o orquestrador, com o selo **MISSÃO · N** (o clique abre a tela de missões). Nenhum `<Terminal>` muda de `key`, pai ou ponto de montagem. A seção de missões (`MissionsSection`) deixou de repetir os terminais embaixo de cada missão.
- **Criar e iniciar:** a `MissionsSection` (criar `+`, **Iniciar**, **Encerrar**) agora também mora na sidebar do chat; é a mesma de Abas e Canvas e usa os mesmos comandos (`missions.create`, `startMissionInTerminals`). Criar missão nunca lança processo; iniciar é gesto explícito, com `confirm_spend` e orçamento como sempre.

### A conversa segue o modo (uma conversa só em Chat, Abas e Canvas)

A conversa escolhida é a **mesma** nos três modos, e trocar de conversa em qualquer um reflete nos outros.

- **Seleção única:** a ref (`tab.id` ou `thread:<id>`) à vista é `selectedRef({ thread, activeTabId })` (`chat/unified/selection.ts`; hook `useSelectedRef`). A conversa por protocolo aberta vence a aba ativa; **ativar uma aba** (a tira, o canvas, a sidebar, mesmo a que já é a ativa: `activationListeners` do store de abas) fecha a conversa por protocolo. A sidebar das Abas e do Canvas marca a seleção por essa ref.
- **`selectConversation(ref)`** (`unified/selectionActions.ts`) é o único caminho da sidebar: protocolo abre a conversa; TUI ativa a aba; nos dois casos pede ao canvas que centre o nó (`canvasActions.focusRef`). Só estado: nenhum `<Terminal>` muda de `key`, pai ou ponto de montagem. `startSelectionSync` (no `AppShell`) mantém `useCanvasStore.activeThread` (o canvas da conversa por protocolo aberta) em dia, venha a abertura de onde vier.
- **Canvas:** `Board.threads` (`thread:<id>` → retângulo; TS `canvas/board.ts`, Rust `canvas/mod.rs` com `#[serde(default)]`, teste de ida e volta em `canvas/test.rs`). O cartão (`ThreadNode.tsx`) reaproveita `StructuredConversationView` (timeline, estado, aprovação e composer), em React puro, sem xterm. O cartão nasce **quando a conversa é escolhida** com o canvas dela no modo Canvas, ou quando uma corda do time a liga a algo; nunca em massa no boot. `addThreadNode` acha um lugar livre sem cobrir terminais, notas, portais, pastas, imagens nem outros cartões. `reconcile` mantém a corda **e** o nó; só descarta o nó se receber `liveThreads` (conversa encerrada) e, sem essa lista, nada some. O canvas da conversa é (`homeBoardKey`): onde já há nó dela (o especial vence), senão onde está a coroa do time, senão a pasta do `cwd`.
- **Abas:** qualquer conversa por protocolo escolhida (de time ou não) abre o `ProtocolPane` por cima da área (`EditorArea::SelectedProtocolPane`); os terminais seguem montados por baixo.
- **Não verificado visualmente** nesta etapa (sem instância isolada rodada): só vitest, tipos e o teste Rust.

## Retomada, fila e avisos na timeline (etapa 3 do harness)

- **Retomar uma sessão que falha não esquece em silêncio** (`conversa/resume.rs`): o erro de `--resume`/`thread/resume`/`session/resume` é `Gone` (a sessão não existe: abre outra), `Transient` (2 retentativas com pausa curta; se persistir, abre outra), `Timeout` (NÃO abre outra: a sessão pode existir; falha e a pessoa tenta de novo) ou `Fatal` (o processo não sobe, ou modelo/modo não aplicam: falha). Ao abrir outra, a timeline recebe um item `notice` (`resumeLost`) e a tela diz que o agente recomeçou sem o histórico; o id da sessão anterior só é trocado depois de a nova abrir.
- **OpenCode falha fechado** em modelo, esforço e MODO: um erro ao aplicar recusa a abertura (as permissões nunca divergem do que a tela mostra). O esforço que o modelo não oferece fica no padrão, mas vira um `notice` (`optionIgnored`). Um OpenCode que nem lista a opção `mode` não tem o que mostrar errado (as permissões valem pelo ambiente do processo).
- **A fila do agy e do OpenCode** (`turn::Lane`: turno + fila sob UMA trava) só grava o item `User` quando o turno da mensagem começa; a tela a mostra como pendente até lá (sem o prazo de 2 min enquanto o agente trabalha). Se interromper ou fechar descarta a fila, cada mensagem vira um `notice` `queueDropped` («não enviada», com o texto e «Reenviar»).
- **Uma trava de abertura por conversa** (`resume::start_gate`), não uma por motor: um agente lento no `initialize` não segura as outras conversas.
- **Item `notice`** (`ItemKind::Notice`; `label` = código): linha própria no fio, fora dos turnos. A mensagem da pessoa no meio de um turno (steer, fila) fecha o turno anterior como «superado» (`TurnEnd.superseded`), e o fim de verdade vai para o turno que tem a resposta.
- **@menção do orquestrador**: a mensagem aparece como pendente na conversa que a pessoa olha, o erro de envio aparece ali, e, numa conversa por protocolo, o resumo do time só conta como entregue depois de o backend aceitar o envio (na fila do composer e numa aba, não há resposta a esperar: conta ao enfileirar/entregar).

## Permissão decidida no backend (etapa 3, parte B)

A política do integrante e as regras «Sempre permitir» da pessoa são aplicadas pelo BACKEND (`conversa/permission.rs`, `chat_team/permission.rs`), não mais pelo React: a decisão vale com a casca do chat fechada, com a conversa em segundo plano e depois de recarregar a janela.

- **Na chegada** (`on_arrival`, nos três motores): o motor monta o pedido INTEIRO (`Subject`: o comando completo, não o título, que guarda só a primeira linha), grava-o em `chat_request.subject` e decide: política do integrante (`model::decide`, que pode negar) e depois as regras. `Allow`/`Deny` respondem ao agente na hora; o resto fica `pending` e vai à tela.
- **Nunca automático**: risco alto (push, `rm -r`, `sudo`, `--force`, `curl | sh`…), perguntas do agente e a saída do Plano. Falha de leitura (time, regra) = a pessoa decide. Um pedido sem `subject` (de antes desta versão) nunca é decidido sozinho. Regra com escopo de papel ou de time (`role`, `team_id`, preparados) ainda não decide nada.
- **Só a pessoa cria regras**: tabela `chat_permission_rule` (`origin` só `person`), comandos Tauri chamados pela tela; nenhum comando de CLI/MCP escreve regra (teste de contrato em `chat_team/test.rs`). As regras antigas dos settings (`chat.permissions.rules`) foram COPIADAS uma vez, sem apagar o setting.
- **Interruptor por time** (`chat_team.auto_decide`, padrão ligado; «Não decidir sozinho» no painel do time): desligado, tudo vai à pessoa.
- **Varredura** (`chat_requests_sweep`): reaplica a decisão aos pendentes de todas as conversas ativas ao montar a janela, ao criar/mudar uma regra e ao religar o time. No arranque do app não há pendentes (o agente morre com o app e `sweep_orphans` os expira).
- **Auditoria**: `chat_request.decided_by` (`person`, `policy`, `rule:<id>`) e `decided_why`; o aviso `requestResolved` leva `by`/`why` e `ags chat pending` lista os últimos (`decided`).
- **Caminhos** (`resolve_path`, TS e Rust): resolvidos por TEXTO antes de tudo: `.` e `..` resolvidos, `//` e `\` como `/`, letra de disco do Windows sem diferenciar maiúsculas. O `..` que sobe acima da pasta, `~`, `$VAR`, `%VAR%` e crase são FORA (e sensíveis, se não se entendem); a edição só casa regra se estiver provadamente dentro, pelo caminho normalizado. O backend ainda confere os **links simbólicos no disco** (`Subject.escapes`): um link para fora da pasta conta como fora.
- **Comando por dentro** (`analyze_command`): separa por `&&`, `||`, `|&`, `;`, `|`, `&` isolado, `\r` e `\n`; os redirecionamentos que escrevem (`>`, `>>`, `&>`, `>|`) são acusados (menos `/dev/null` e `2>&1`); crase, `$`, `<(`, `>(`, heredoc, barra invertida e aspas no meio de palavra (`r'm'`) não se interpretam. Regra nunca casa nem o risco é «baixo» com isso. Risco alto, por parte e atrás de `xargs`/`command`/`sh -c`: `rm` com qualquer flag recursiva/forçada, `git` com opções globais antes do subcomando, `chmod`/`chown -R` e modos como 777, `find -delete`, `sudo`/`doas`, e `mv`/`cp`/`ln`/`tee`/`sort -o`/redirecionamento para caminho sensível fora da pasta.
- **«Só leitura» é uma lista curta**: `ls`, `cat`, `rg`, `git status|diff|log…`, etc., sem as opções que rodam ou escrevem (`rg --pre`, `find -exec`, `sort -o`, `git -c`). `env x`, `xargs`, `sh -c`, `less`/`man` e os executores de código do repositório (`bun run test`, `cargo test|build|clippy`, `vitest`: scripts, `build.rs` e testes que o agente acabou de editar) NÃO são baixo risco (continuam podendo ter regra da pessoa).
- **Uma resposta só ao agente** (`conversa/answer.rs`): o pedido é RESERVADO no banco (`claimed_at`, só se `pending`) antes de responder; quem perde não envia, o envio que falha devolve a reserva, e a decisão da pessoa vence a automática que chega junto.
- **Ferramenta de fora do shell** (MCP, `Task`, ferramentas do OpenCode que não são `execute`): `Subject.foreign`. Nenhuma regra de shell a casa; só o acesso total a libera, e só com a flag do time «Acesso total libera ferramentas de fora do shell» (`chat_team.allow_tools`, desligada por padrão).
- **Mesmo veredito nos dois lados**: as fixtures `src/features/chat/permissions/fixtures/permission-cases.json` (geradas do TypeScript) são lidas pelo vitest e pelo `cargo test`. TUI e frota seguem decididas na janela (`decidedByBackend`).

## Anexos: colar, arrastar, miniaturas

O composer do chat (conversa aberta, "Nova conversa" e mensagens de time) aceita anexos como o Claude Code:
Cmd/Ctrl+V cola a imagem do clipboard e arquivos copiados (lista `text/uri-list`); arquivos e pastas do Finder
soltos na coluna do chat inteira (realce "Solte para anexar"); o clipe usa a mesma regra. Eles aparecem como
miniaturas acima do texto (imagem = cartão com prévia; arquivo/pasta = chip com nome e tamanho; "×" com mouse
ou foco) e, na mensagem enviada, acima do balão; clicar numa imagem a amplia (visualizador com Esc, clique fora e
setas). Enviar só com anexos vale; o mesmo caminho duas vezes vira um só. O bloco do composer cresce com o texto e
as miniaturas até 40% da janela e rola por dentro, sem barra, com o enviar sempre à vista.

**Segurança.** A tela manda só CAMINHOS que a pessoa colou, soltou ou escolheu. O backend (`conversa/attach.rs`)
só faz `stat` neles (`chat_attachment_inspect`) e só lê imagens (`png/jpg/webp/gif`) para a prévia
(`chat_attachment_read`, até 20 MB) ou para o Claude (até 5 MB cada, 8 por mensagem). Pasta = só o caminho
(nada é listado). Imagem colada vai para `~/.ags/tmp/pasted` (`save_pasted_image`, 700/600, limpa em 24 h).

**Limites.** 10 anexos por mensagem; imagem até 20 MB; outros arquivos até 100 MB (o agente os lê pelo caminho);
soma de 200 MB. O que passa do limite fica de fora COM aviso; erro de leitura vira aviso; o texto digitado nunca se perde.

**Como cada motor recebe** (decisão; o caminho no texto é o fallback de TODOS e nunca é omitido):

| Motor | Caminho no texto | Imagem em linha |
|---|---|---|
| Claude Code (stream-json) | bloco `[Anexos]` | sim: blocos `image` base64 antes do texto (≤ 5 MB, ≤ 8) |
| Codex (`app-server`) | bloco `[Anexos]` | não: o item `localImage` do `turn/start` não foi verificado neste app |
| OpenCode (ACP) | bloco `[Anexos]` | não: `promptCapabilities.image` ainda não é lida |
| Antigravity (`agy -p`) | bloco `[Anexos]` | não |
| Abas com TUI | `@caminho` no fim do texto | não (a TUI lê pelo caminho, como ao soltar no terminal) |

O bloco é `[Anexos]` + uma linha `- imagem|arquivo|pasta | nome | bytes | caminho` por anexo, no fim do texto.
Como ele fica na mensagem guardada pelo motor, a bolha o lê de volta (`splitAttachmentBlock`) e mostra as
miniaturas ao reabrir a conversa, em qualquer motor, sem campo novo no banco. Uma imagem colada é limpa em 24 h:
depois disso a miniatura mostra "indisponível" (o caminho continua na mensagem). Mensagens de time (`@menção`,
"Time | Só o orquestrador") levam os anexos pelo mesmo caminho.

## Fala do agente × mensagem da pessoa (acabamento)

- **Balão só do usuário.** A mensagem da pessoa tem balão (`rounded-2xl`, `px-4 py-2.5`, fundo cinza translúcido,
  à direita, até 85% da coluna, "Mostrar mais" ao passar de ~8 linhas). A fala do agente fica SEM balão: texto
  corrido, com o logo e o nome acima na primeira fala depois da pessoa e sempre que a voz muda (`speakers.ts`);
  falas seguidas da mesma voz (com ferramentas no meio) não repetem a linha. **Aproximação**: sem o Claude desktop
  à mão, raio, padding e largura seguem o desenho já usado; ajustar em `timeline/Bubbles.tsx` se a comparação lado a
  lado pedir.
- **Mensagem entre agentes.** O envelope cru (`[Mensagem #68 de X via ADE AGS]`, a frase de aviso, a tag
  `untrusted_data`, a dica de resposta) só existe no que vai ao agente e no banco; a tela mostra o logo e o nome de
  quem mandou (sem balão) e o conteúdo. O pedido tipado (`X pediu sua ajuda nisto. Tarefa: … Contexto: …`) vira a
  tarefa e, em negrito, só os campos preenchidos (valores-padrão somem). O número da mensagem (`#68`, do
  `ags peer receipt`) fica só na dica (tooltip). Ver `timeline/peerEnvelope.ts`.
- **Perguntas.** O cartão «O agente fez uma pergunta» de uma conversa por protocolo responde ao clique enquanto a
  pergunta espera (as opções são botões); respondida, vira registro. Listas em texto do agente nunca viram botão.
  Em abas com TUI o cartão continua levando ao terminal.
- **Rolagem.** O Resumo é o miolo (`flex-1 min-h-0`) do cartão flutuante, que é uma coluna flex de altura limitada;
  sem isso o miolo crescia com o conteúdo e a roda não rolava.
- **Composer.** A altura segue o texto e também a largura da caixa (`ResizeObserver`): abrir o painel direito
  refaz a altura sem digitar.

## Trocar de agente na mesma conversa (como o T3 Code)

Em uma conversa por protocolo (Claude Code, Codex, OpenCode, Antigravity, Cursor), o seletor de modelo mostra o trilho de
agentes instalados. Escolher OUTRO agente troca quem responde NESTA conversa, com confirmação a cada troca. Vale também
para o orquestrador e os integrantes de um time. Abas com TUI ficam de fora (o terminal é do usuário).

- **Regras.** Só entre turnos e sem pedido do agente esperando resposta (`chat_thread_switch_agent`, `conversa/troca.rs`).
  Mesmo id, pasta, título, linha do tempo, fila de mensagens (`thread_outbox`) e time. O acesso vira o equivalente do
  motor novo (o Plano não existe no Codex: vira Supervisionado, e o aviso diz); o esforço zera; a conta do agente
  antigo não vale no novo (conta principal ou a escolhida).
- **Sessão nativa.** A do agente que sai fica guardada em `chat_thread_native` (aditiva, nada apaga). Voltar a um agente
  já usado retoma a sessão dele (na mesma conta) e leva só o resumo do que aconteceu fora (delta); um agente novo, ou
  de outra conta, recebe o resumo completo.
- **Resumo (`conversa/handoff.rs`).** Determinístico, sem gastar cota (como o T3 Code): pedido original, falas mais
  recentes sob o teto do T3 Code (64 000 bytes ≈ 16 mil tokens; as mais antigas saem, o corte é dito e a linha diz como ler o
  resto), o pedido corrente da pessoa e o último turno do agente anterior logo no começo, a linha-dado «a conversa completa
  está em `ags chat show <id>` (somente leitura)», arquivos alterados, plano e pergunta sem resposta; sem raciocínio escondido. É DADO, nunca instrução: dentro do bloco `untrusted_data` do app, começando por
  `[ADE AGS]`. Vai na frente da PRÓXIMA mensagem da pessoa (não é um turno à parte) e só sai da pendência quando a
  mensagem foi enviada de fato. A tela esconde o bloco (termina na marca `[fim do contexto da conversa anterior]`).
- **Timeline.** Aviso persistente `agentSwitch` («Agora com Codex · modelo» e o que o agente novo recebeu); cada fala do
  agente leva o logo e o nome de quem a disse (`voicesByItem`); o histórico antigo continua à vista.
- **Time.** `chat_team.agent_id`/`chat_team_member.agent_id` e o rótulo `Agente · Papel` acompanham a troca.
- **ai-memory.** É por motor (Claude por processo; os demais sem suporte): o estado é zerado e recalculado ao abrir.
- **Anexos.** O bloco `[Anexos]` e os caminhos continuam no texto; imagem em linha só se o motor novo for o Claude.
- **Coordenação com o pool de contas** (`pool-contas`, `conversa/pool.rs`): o resumo dela (`handoff_text`) é o mesmo
  conceito com outra moldura («conta anterior»). Quando os dois PRs entrarem, `pool.rs` pode chamar `handoff::resumo`
  (parametrizado por quem sai e quem entra) em vez da função própria; os dois tocam `api.rs::send_mode`, `store.rs`,
  `mod.rs` e `NoticeRow.tsx`, então o merge pede conferência.

## Acabamento (build local do PR 270/271)

- **Resumo** (como no Claude Code). O ícone do Resumo liga e desliga o Resumo (`summaryPinned`, lembrado; ligado por
  padrão).
  - **Sem outro painel:** é uma coluna fixa à direita (350 px, encolhe até 280), abaixo da barra de ícones. A barra fica
    com a largura inteira, acima dela, e nunca é coberta. Tem o fundo do tema, divisória à esquerda e as seções em
    linhas com divisórias finas (`SectionsInOneCard`), sem um cartão cada. Nunca cobre a conversa nem o composer.
  - **Outro painel** (simulador, navegador, terminal, arquivos, prancheta) substitui a coluna. Fechar o painel a traz
    de volta, se o Resumo estiver ligado.
  - **Com outro painel aberto**, o ícone abre o cartão flutuante (`summary/SummaryPopover.tsx`, `summaryOpen`), um pouco
    menor (310 px). Ele fica logo abaixo do cabeçalho, com a borda direita encostada no painel, e é desenhado pela
    coluna da conversa (`<main>`), então acompanha o redimensionamento. Fecha com clique fora, com Esc (o foco volta ao
    ícone), ao trocar de conversa e ao fechar o painel. Com o painel maximizado, abrir o cartão restaura o painel antes,
    para ele não cair sobre o simulador ou o navegador, que são nativos.
- **Prancheta em tela cheia** (`/design/:id`, `chatSpaces.isFullscreenRoute`). Ocupa a janela toda, sem a sidebar de
  Espaços, que antes aparecia por cima. Tem «Sair da tela cheia» sempre à vista no cabeçalho, e o Esc também sai. Na
  barra da prancheta, à direita, fica só o botão de tela cheia: o de alternar o painel lateral do estúdio parecia
  duplicado e saiu, mas o painel continua no atalho ⌘\. A barra não se encavala no painel estreito: a barra é um
  `@container/studiobar`. Abaixo de 36rem, só Seleção e Mão ficam à vista, e o resto (Texto, Prancheta, Nota, desenho,
  formas, Comentar) vai para o menu de excesso (⋯). O seletor de página encolhe e trunca, e o grupo do zoom não
  encolhe.
- **Barra de abas da coluna direita (estilo T3 Code).** A coluna tem a própria barra no topo (`ColumnTabBar.tsx`): as abas
  abertas (ícone + nome, "×" e clique do meio fecham), o "+" com o menu **Abrir uma superfície** e, à direita, expandir,
  painel inferior (a gaveta do terminal do agente) e recolher a coluna. Coluna vazia mostra "Abrir uma superfície" com a
  mesma lista. O menu (`SurfaceMenu.tsx`, `panelMenu.ts`) tem uma letra por linha, valendo com o menu aberto: B Navegador
  (submenu com os perfis, se houver mais de um), T Terminal, F Arquivos, D Diff, P Pull request, M Aparelho (submenu iOS e
  Android), S Pergunta lateral, E Design, O Time. As letras são as do T3; E e O são do ADE. Navegador e terminal aceitam
  várias abas (o "+" abre sempre uma nova); as demais superfícies têm uma só (abrir foca a que existe).
- **Estado das abas** (`columnTabs.ts` puro + `useChatStore.columnTabs/columnActive`). `panel` continua sendo a superfície da
  aba ativa (atalhos, comandos e `setRightPanel`/`addSurface` seguem iguais): um subscriber (`reconcileColumn`) cria/ativa a
  aba que corresponde. As abas não persistem entre aberturas do app (só `panel`, como antes).
- **Terminal e navegador não remontam ao trocar de aba.** Como antes, só o slot da aba ativa mede o espaço e publica
  (`setChatBrowser`/`setChatShell`); `ViewTabsHost`/`TerminalPanel` mantêm as instâncias montadas e escondidas. Cada aba
  guarda o recurso que mostra por escopo (conversa + pasta no navegador, pasta no shell), para que duas abas nunca mostrem
  a mesma página/shell. **Fechar uma aba só tira o assento da barra: a página e o PTY continuam vivos** (o próximo "+"
  reaproveita os que sobraram). A limpeza do slot só despublica o que ele mesmo publicou, para a troca entre duas abas do
  mesmo tipo não apagar o slot novo.
- **O que ficou no cabeçalho da conversa** (`PanelToolbar.tsx`): Resumo (o "thread details" do T3) e Tarefas; com a coluna
  fechada, também o painel inferior e o abrir da coluna. Com ela aberta, esses dois moram na barra da coluna. Time, Diff,
  Arquivos, Navegador e Aparelho saíram da fileira e abrem pelo "+" (a fileira e o ⋯ deixaram de existir). Com a coluna
  maximizada, o cabeçalho some, então Resumo e Tarefas só voltam ao restaurar.
- **Pull requests no chat.** Com uma pasta aberta, a entrada Pull request do menu "+" abre o Forge no painel lateral. A lista
  mantém os filtros, atualização, criação e detalhe existentes. “Vinculados à branch” filtra pela branch de origem e
  fica desativado sem branch; trocar de pasta ou branch limpa a seleção de PR aberto. A sessão reaproveita a conta do
  Forge já conectado (`PullRequestPane`), sem credenciais próprias.
- **Painel numa janela estreita.** Toda coluna do painel encolhe até 280 px, e a conversa fica com 440 px no mínimo. Antes,
  numa janela de ~1000 px, o painel passava da borda e o cabeçalho cortava o ícone de fechar o painel; agora o cabeçalho só
  leva Resumo e Tarefas, e as abas da coluna rolam na horizontal.
- **A fala depois de trocar de agente.** A primeira mensagem depois da troca leva o resumo da conversa anterior na frente
  (até ~64 KB). A gravação cortava em 20 000 caracteres pelo fim: perdia a marca de fim do resumo e a fala da pessoa. A
  tela escondia o item, e o balão otimista ficava «Na fila» no fim da timeline até sumir. Agora `handoff::clip_user`
  encolhe o resumo e preserva a marca e a fala; o agente sempre recebeu o texto inteiro. A tela também tira da fala o
  aviso `[Aviso do ADE AGS, não da pessoa] TOOL_OUTCOME_UNKNOWN…`, que já aparece como aviso próprio
  (`userMessage.ts`). Antes, ele colava na fala e impedia o balão de achar o eco.
- **Conta da conversa.** Fica dentro do seletor de agente/modelo, no rodapé do popover (`AgentModelPicker.accountSlot`,
  `ThreadAccountMenu`), e não como um seletor solto no composer entre o modelo e o esforço.
- **Ações sob a mensagem.** Hora relativa («há 24 minutos») e botões só ao passar o mouse ou focar (`MessageActions`): copiar
  (texto limpo, sem anexos nem envelope) na pessoa e no agente; «editar e reenviar» na pessoa devolve o texto ao campo
  (não cancela nada). Ficam para depois: bifurcar a conversa daquele ponto (o `handoff.rs` já serve de base), fixar e ler em voz alta.
- **Limites de uso.** O cartão lista TODAS as contas conectadas dos agentes que expõem a cota (Claude, Codex e Antigravity),
  as da conversa primeiro, cada uma com a janela atual e a semana; «não medido» só para o agente que não expõe a cota. O
  Antigravity sem perfil usa a mesma leitura do canvas (`agy /usage`, por grupo de modelos). O Cursor instalado
  entra na lista como conta («não medido · sem fonte de cota»): o uso dele só sai com o token do Cursor, e o ADE não lê
  credencial de outro app. Opções (a decisão é do usuário): (a) deixar assim; (b) `cursor-agent status --format json` para
  mostrar a conta/e-mail (comando do próprio CLI, não mede cota; não verificado aqui); (c) a Admin API do Cursor, só para
  times, com uma chave que o usuário cadastre no keyring do ADE.
- **Trocar de agente e aprovação.** O Antigravity e o Cursor por `-p` não têm tela de aprovação: em Supervisionado ele NEGA o que pediria
  aprovação. A confirmação da troca e o aviso do fio dizem isso (`noApproval`); para liberar, mude o acesso.

## Tarefas em segundo plano (como no Claude Code)

O painel lista os subagentes e os comandos que o agente deixa rodando na conversa por protocolo, em árvore.

- **Entrada:** o botão da fileira do cabeçalho (`tasks/TasksButton.tsx`), sempre à vista e nunca no ⋯. Mostra um selo
  com quantas rodam e fica destacado por 4 s quando uma começa. O painel nunca abre sozinho.
- **Painel:** é a aba `tasks` do painel direito (`tasks/TasksPanel.tsx`) e segue as regras do Resumo. Abrir substitui a
  coluna fixa do Resumo; fechar a traz de volta. Com o painel aberto, o Resumo vira o cartão flutuante. Não volta aberto ao
  reabrir o app.
  - O cabeçalho tem três botões: limpar as concluídas, expandir sobre a conversa (o maximizar do painel) e fechar.
  - **Em execução N:** cada linha tem o tempo correndo e o parar. Os filhos ficam debaixo do pai, no "▸ N tarefas".
  - **Concluído N:** começa recolhido. Mostra o status (concluída, falhou, parada, interrompida) e a duração.
- **Detalhe** (o chevron): o pedido, a saída do shell ou o que o subagente fez, e o resultado. A seta volta à lista (Esc
  também) e devolve o foco à linha.

### O que cada motor expõe

| Motor | De onde vêm as tarefas | Parar uma tarefa só |
|---|---|---|
| Claude Code (`claude -p`, 2.1.318) | linhas `system` `task_started` (com `parent_task_id`, `tool_use_id`, `task_type` `local_bash`/`local_agent`), `task_progress`, `task_updated`, `task_notification` e `background_tasks_changed`; o que o subagente faz vem nas linhas com `parent_tool_use_id` (`taskItem`) | `control_request` `stop_task` (`chat_task_stop`). Para shells, o detalhe acompanha o arquivo temporário `tasks/<id>.output` durante a execução e lê os últimos 8 KiB; usa o controle `get_task_output` (`chat_task_output`) quando não há raiz temporária disponível. |
| Codex (`app-server` 0.166) | itens `collabAgentToolCall` (`spawnAgent` e os `agentsStates`) e `subAgentActivity` | não tem: o `turn/interrupt` pediria o turno da thread do subagente, que o app não acompanha. O botão fica desligado, com o motivo |
| OpenCode, Cursor, Antigravity | a ferramenta `task` da timeline, que já está no banco | não tem. O botão fica desligado; o Parar do composer para o turno inteiro |
| Conversa de TUI | — (o próprio `/tasks` da TUI) | — |

- O backend fica em `conversa/tarefas.rs`, que é puro. O `claude_map` entrega `Out::Task` e `Out::SubItem`; o `codex.rs`
  emite os eventos dos itens. Nada disso abre turno nem vai à tabela `chat_item`.
- O app nunca para a conversa inteira por este botão e nunca encerra processo por nome.
- **Guardar:** a store (`tasks/tasksStore.ts`) separa as tarefas por conversa (`thread:<id>`). Ela grava na tabela
  `settings` (`chat.tasks`), sem tabela nova e sem migração.
  - Ao reabrir o app, o que rodava volta como "interrompida", porque o processo do agente morre com o app.
  - O que o subagente fez fica só na memória.
- **Conferido ao vivo** no Claude Code 2.1.318, com duas conversas mínimas com o haiku: os eventos chegam como descrito e `stop_task` mata só aquele shell (`task_updated` `killed` e depois `task_notification` `stopped`).
- A leitura do arquivo temporário é coberta por teste local; leitura ao vivo e atualização durante a execução não foram repetidas nesta alteração.
- **Não conferido ao vivo:** o Codex (só os tipos gerados) e um subagente aninhado de verdade (`parent_task_id`).

## Como não derruba terminais

- O workspace continua montado por baixo da casca do chat:
  - topo, riel, painel de workspaces e barra de status ficam `hidden`;
  - o canvas fica `visibility: hidden`, porque os portais dele são navegadores.
- O terminal da conversa **não** é montado pela tela do chat:
  1. `ConversationView` mede o espaço que reserva e publica em `useChatStore.slot`.
  2. `placementsFrom` (com `chat`) mostra só a aba ativa nesse retângulo (`CHAT_GROUP`).
  3. O `TerminalPanel` posiciona a TUI ali, do mesmo jeito que o canvas faz com `liveRects`.
- Trocar de modo não muda `key`, pai nem ponto de montagem de nenhum `<Terminal>`.
- No chat, o `TerminalPanel` fica transparente e sem pegar o ponteiro (como no canvas). A área de abas fica acima da casca (`z-index 20`, `pointer-events: none`), e só o terminal visível recebe cliques.

## Arquivos

| Onde | O quê |
|---|---|
| `src/app/uiStore.ts` | `chatMode` (flag), `shellMode` (`chat` / `workspace`), `chatShellOn`, `useChatShell` |
| `src/features/chat/` | `ChatShell`, `ChatSidebar`, `NewConversation`, `ConversationView`, `ChatComposer`, `AgentModelPicker`, `AccessMenu`, `ShellModeSwitch`, `ChatEntryButton`, `ChatModeSetting` |
| `src/features/chat/ChatPage.tsx`, `ChatPageSidebar.tsx`, `chatSpaces.ts` | telas cheias no chat, sidebar das Configurações e dos Espaços |
| `src-tauri/src/conversa/`, `src/features/chat/structured/` | conversa por protocolo (Codex pelo `app-server`, Claude Code pelo `claude -p` em stream-json) |
| `src/features/chat/DesignPane.tsx`, `DevicesPane.tsx`, `devicesModel.ts`, `devicesIpc.ts` | abas Design, Simulador iOS e Android do painel direito |
| `src/features/chat/chatModel.ts` | lógica pura: título da conversa, comando, projetos e cartões |
| `src/features/tabs/layout/layoutStore.ts` | `CHAT_GROUP`, `chatPlacements`, `placementsFrom({ chat })` |
| `src/app/shortcuts.ts` | `toggleChat` (Ctrl+Shift+L) |

## Próximas fases

O plano completo, com as fases F2 a F7, fica fora do repositório. Resumo:

| Fase | O quê |
|---|---|
| F2 | Conversas estruturadas (timeline com mensagens, ferramentas e diffs) num módulo Rust `conversa/`, começando pelo `codex app-server` |
| F3 | Aprovações e perguntas dentro do chat; modos Aceitar edições e Acesso total; Plano |
| F4–F6 | Claude e ACP; painel direito (diff, arquivos, navegador, dispositivos) e drawer de terminal; telas no visual novo |
| F7 | `ags chat`, MCP e skill |

## Vigia do chat (o orquestrador ciente dos integrantes)

Um time de conversas por protocolo não tem terminal para o Vigia das missões olhar. O **vigia do chat** (`chat_team/watch*.rs`, `ipc/commands/chat_watch.rs`) lê o que o backend já tem (pedidos `chat_request`, turnos `chat_run`, a timeline) e avisa o orquestrador, pela fila durável, quando um integrante: espera a **pessoa** há ≥ 20 s (comando, edição, pergunta), terminou o turno perguntando algo a ela, ou teve o turno falho; e quando a pessoa destrava. «Sem progresso» (15 min sem item novo) é um segundo interruptor, desligado por padrão. Os dois ficam no painel Time (`chat_team.watch`, `chat_team.watch_stall`). Com `watch`, também avisa o **«terminou» tipado** (o turno que o orquestrador pediu acabou sem o integrante mandar mensagem: `stopReason` `completed`/`aborted`/`error`/`max-tokens`/`refusal`/`timeout` e o último parágrafo da fala) e o **contexto acima de ~80%** (só Claude; uma vez por hora). Com `watch_stall`, a **chamada repetida** (escada 3/5/8) e o **TIMEOUT**. O watchdog de TIMEOUT (turno aberto esperando o modelo, sem ferramenta rodando nem pedido à pessoa, 5 min sem item) marca sempre a timeline do integrante (`turnTimeout`), sem interromper nada. Quando uma conversa cai (ou é interrompida) com ferramenta sem resultado, a ferramenta vira erro com `TOOL_OUTCOME_UNKNOWN`, a timeline ganha o aviso `toolOutcomeUnknown` e o próximo envio leva a nota ao agente («só repita se for idempotente; senão confira o estado»). Sem LLM e sem cota; só avisa, e a decisão é sempre da pessoa. Detalhes: [`docs/agentes/VIGIA.md`](../agentes/VIGIA.md#no-chat-times-de-conversas-por-protocolo).

## Pool de contas na conversa

Com «pool:Nome» como conta e o interruptor ligado (Contas → Pools → «Pool de contas no chat»: desligado, avisar e perguntar ou automático), uma conversa por protocolo cujo turno falha por limite segue em outra conta do mesmo pool, com o resumo das últimas falas, e volta à original quando ela renova. Detalhes, tetos e a ressalva de política em [POOL_FAILOVER.md](./POOL_FAILOVER.md#pool-de-contas-no-chat-conversas-por-protocolo).

## Limite de uso, modelo reserva e título por modelo

Um turno que para por limite de uso pode (1) perguntar se a conversa segue com o **modelo reserva do projeto** (Configurações → Projetos), sem trocar sozinha, e (2) agendar a **retomada** para a hora de renovação que o agente informou, se «Retomar depois do limite de uso» estiver ligado (Threads). Os avisos da timeline são `fallbackOffer`, `fallbackSwitched`, `limitResume`, `limitResumed` e `limitResumeFailed`; a pergunta do reserva é o `chat_pool_pending` com `kind: "fallback"` (e `agentId`/`model`, opcionais), aceita e dispensada pelos mesmos `chat_pool_accept`/`chat_pool_dismiss` do pool de contas. O título da conversa pode ser escrito por um modelo (uma chamada curta e somente leitura, desligada por padrão) e ganhar «Regerar título» no menu. Comandos novos: `chat_project_defaults_*`, `chat_limit_resume_*`, `chat_title_settings_*`, `chat_title_writers` e `chat_thread_regenerate_title`. Detalhes e limites em [T3_CODE_INTEGRACAO.md](./T3_CODE_INTEGRACAO.md#padrões-por-projeto-título-por-modelo-e-limite-de-uso-backend).
