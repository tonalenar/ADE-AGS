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
