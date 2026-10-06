# Canvas de Design: pranchetas, comentários e aprovação

O agente desenha a interface como **pranchetas** (artboards) HTML antes de construir. O usuário vê, comenta e edita item por item; só depois de aprovar o agente constrói.

## Fluxo: desenhe primeiro, aprove, construa

1. O agente cria um design (`ags design create`), páginas e pranchetas com HTML autocontido.
2. O usuário revisa tanto nas **pranchetas como nós do canvas principal** quanto no modal/painel **Design**: comenta (opcionalmente em um elemento), edita o HTML/CSS ou aprova/rejeita cada prancheta (ou "aprovar tudo").
3. Os comentários do usuário são entregues ao agente dono do design (`ownerTabId`) pelo mesmo caminho do chat do canvas; ele atualiza a prancheta (nova versão) e responde.
4. **Construir aprovadas**: só pranchetas com status `approved` viram tarefas de construção (`src/features/canvas/design/buildTasks.ts`), cada uma com o HTML como referência e a instrução de trabalhar no próprio worktree. Rascunhos e rejeitadas não geram nada, e nada é construído antes da aprovação.

## Design no Canvas Principal (Etapa 19)

As pranchetas de um design agora podem ser dispostas diretamente no canvas principal como nós interativos:

- **Moldura e Agrupamento (`layoutGroups`)**: Páginas e designs são exibidos em grupos com moldura (`frame`), contendo cabeçalho com nome do design/página, badge de dono e ações de arquivar/excluir.
- **Origem Livre (`freeOrigin`)**: Quando novos designs são adicionados, são posicionados automaticamente à direita de todos os elementos existentes do canvas (terminais, notas, portais, pastas) com margem (`AREA_GAP`), evitando sobreposição com o trabalho em andamento.
- **Posicionamento Automático e Arraste sem Regressão**:
  - Pranchetas criadas sem posição explícita (x=0, y=0) são espalhadas horizontalmente na tela (`spreadOverlapping`) com espaçamento padronizado (`BOARD_GAP = 48px`).
  - Mover uma prancheta no canvas grava sua nova posição relativa e preserva o layout das pranchetas irmãs (`positionsToSave`).
  - **Separação de Movimentação e Conteúdo**: Alterar apenas coordenadas `x`/`y` NÃO incrementa o número de versão nem reseta o status para `draft`. A aprovação existente é preservada. Desfazer (`revert`) restaura o conteúdo HTML/título sem desfazer a posição manual no canvas.
- **Foco Automático e Navegação**:
  - O canvas enquadra automaticamente as pranchetas ao abrir o design ou mudar de página (`fitViewport`).
  - Ao clicar em "Abrir" em um aviso de novo design, a câmera do canvas viaja diretamente até a moldura do design correspondente.
- **Aviso de Novo Design (`freshDesigns`)**:
  - Quando um agente emite `ags design create`, o evento `design-changed` com `isNew: true` dispara um toast de notificação (`canvas.design.newDesign`).
  - O toast traz botão rápido "Abrir", permitindo inspecionar o trabalho do agente imediatamente sem interromper o fluxo.

## Deduplicação, Exclusão e Arquivamento (Schema v37)

- **Deduplicação Automática**: Criações subsequentes com o mesmo título dentro da mesma missão (`mission_id`, `title`) ou mesmo workspace (`workspace`, `title`) reutilizam o design existente em vez de criar registros órfãos duplicados.
- **Migração v37**:
  - Consolida designs legados duplicados (como ocorrido com "Polir o bot - aura e acabamento").
  - Preserva todas as páginas, pranchetas, comentários e histórico de versões.
  - Registra IDs antigos como *aliases* para que comandos subsequentes direcionados ao ID anterior continuem funcionando com transparência.
  - Adiciona índices únicos em SQLite: `design_mission_title_unique` e `design_workspace_title_unique`.
- **Exclusão Completa (`design_delete`)**: Remove o design e todas as páginas, pranchetas, versões e comentários associados em cascata.
- **Arquivamento (`design_archive`)**: Marca o design com `archived: true`, ocultando-o do canvas principal e da listagem padrão sem apagar o histórico de versões e decisões tomadas.

## Resolução de Dono (Owner) e Resiliência

- **Identificação do Criador**: O dono é atribuído a partir de `from` / variável de ambiente `ADE_TAB_ID` do terminal criador no momento do `design create`.
- **Fallback para Orquestrador**: Se a aba criadora for fechada, `resolveOwner` faz fallback para a aba orquestradora da missão (`/orquestrador|orchestrat|lead/i`).
- **Tratamento de Abas Órfãs**: Se a missão já tiver sido encerrada e nenhuma aba estiver aberta, o painel exibe badge "Sem dono" (`canvas.design.noOwnerBadge`) e trata ações graciosamente, alertando o usuário sem travar a interface.

## Detecção de CLI Desatualizado

- **Inspeção de Build (`cli_build_status`)**:
  - O backend compara a versão e hash de build do executável `ags` ao lado do app com os metadados do app Tauri compilado.
- **Aviso Informativo Único (`useCliOutdatedNotice`)**:
  - Se houver divergência (`cli != app`), exibe um alerta toast uma vez por sessão orientando a recompilar o CLI, evitando comportamentos inconsistentes em agentes interativos.

## Modelo de Dados

`design` (workspace, missão e dono opcionais, título, status, archived) → `page` (nome, ordem) → `artboard` (título, html, largura, altura, x, y, versão, status `draft|approved|rejected`) com histórico de versões e `comment` (autor `user|agent`, texto, seletor opcional, resolvido).

## IPC e CLI

- Comandos IPC: `design_create|list|get|delete|archive|page_add|artboard_add|artboard_update|artboard_revert|artboard_approve|artboard_reject|approve_all|comment_add|comment_resolve`, com `{args:{camelCase}}`.
- Evento Tauri `design-changed`: emite `{designId, isNew, deleted, archived, title, workspace, missionId}`.
- CLI: `ags design create|list|get|delete|archive|page add|artboard add|update|comment|approve|reject`.

## Segurança: o HTML nunca é confiável

Cada prancheta renderiza em `iframe` com `sandbox="allow-scripts"` (sem `allow-same-origin`) e `srcdoc` com CSP `default-src 'none'`, estilos inline e imagens `data:`, `form-action 'none'` e `base-uri 'none'`. Sem rede e sem acesso ao app; o iframe só fala com o painel por `postMessage` (seleção de elemento). No backend o HTML tem limite de tamanho e nunca é executado. No prompt de construção o HTML é escapado e truncado.

## Fora do escopo

Preview real do app em dev server por worktree e compartilhamento por link ficam para a etapa seguinte.
