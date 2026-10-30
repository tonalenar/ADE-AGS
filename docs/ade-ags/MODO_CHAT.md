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
  - popover de 360×346, com favoritos (no `localStorage`), agentes, modelos com busca e a conta no rodapé;
  - o esforço fica num menu à parte, ao lado do modelo.
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
- **Configurações (prancheta 5):** a sidebar do chat vira o menu das seções (`SettingsSidebar`), em três grupos com busca. A página esconde o menu próprio e a coluna de memória.
- **Seção "Modo chat":** saiu de Avançado e virou seção própria (`chat`), com o liga/desliga e dois padrões das conversas novas: worktree por conversa e começar no Plano (os mesmos valores que o composer lembra).
- **Espaços (prancheta 6):** nas outras telas a sidebar lista Conversas e os Espaços (`chatSpaces.ts`). Memória abre a seção das Configurações.
- **Painel direito:** duas abas novas, carregadas sob demanda (puxam o canvas):
  - **Design:** o mesmo `DesignPanel` do canvas, com os designs da pasta da conversa;
  - **Dispositivos:** o simulador iOS (`SimulatorScreen`, a tela nativa) e o Android (quadros do `adb`, toque e deslizar), como os nós do canvas.

## Conversa por protocolo (caminho B): Codex pelo `app-server`

Com o Codex, a conversa nova fala direto com o agente pelo `codex app-server`, sem TUI. Vale para as conversas novas e pode ser desligado em Configurações → Modo chat → "Codex sem terminal". Desligado, o Codex roda na TUI como os outros agentes. As conversas que já existem não mudam.

- **Backend (`src-tauri/src/conversa/`):**
  - `store.rs`: as tabelas `chat_thread`, `chat_run`, `chat_item` e `chat_request`. A migração é só aditiva, sem subir `user_version`.
  - `codex.rs`: um processo `codex app-server` por conversa, com JSON por linha no stdio. Ele sobe na primeira mensagem e retoma a thread do Codex (`thread/resume`) depois de reabrir o app.
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
- **Ainda não:** Claude Code, ACP (Gemini, Kimi) e OpenCode por protocolo; reverter turno; anexos de imagem.

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
| `src-tauri/src/conversa/`, `src/features/chat/structured/` | conversa por protocolo (Codex pelo `app-server`) |
| `src/features/chat/DesignPane.tsx`, `DevicesPane.tsx` | abas Design e Dispositivos do painel direito |
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
