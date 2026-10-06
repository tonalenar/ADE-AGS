# Canvas de Design: pranchetas, comentários e aprovação

O agente desenha a interface como **pranchetas** (artboards) HTML antes de construir. O usuário vê, comenta e edita item por item; só depois de aprovar o agente constrói.

## Fluxo: desenhe primeiro, aprove, construa

1. O agente cria um design (`ags design create`), páginas e pranchetas com HTML autocontido.
2. O usuário revisa no nó **Design** do canvas: comenta (opcionalmente em um elemento), edita o HTML/CSS ou aprova/rejeita cada prancheta (ou "aprovar tudo").
3. Os comentários do usuário são entregues ao agente dono do design (`ownerTabId`) pelo mesmo caminho do chat do canvas; ele atualiza a prancheta (nova versão) e responde.
4. **Construir aprovadas**: só pranchetas com status `approved` viram tarefas de construção (`src/features/canvas/design/buildTasks.ts`), cada uma com o HTML como referência e a instrução de trabalhar no próprio worktree. Rascunhos e rejeitadas não geram nada, e nada é construído antes da aprovação.

## Modelo de dados

`design` (workspace, missão e dono opcionais, título, status) → `page` (nome, ordem) → `artboard` (título, html, largura, altura, x, y, versão, status `draft|approved|rejected`) com histórico de versões e `comment` (autor `user|agent`, texto, seletor opcional, resolvido). Migração aditiva e idempotente (schema v36; v33 a v35 já são de outras missões).

Regras: editar ou reverter volta a prancheta para `draft`; `approve_all` preserva as rejeitadas; `expectedVersion` opcional em update/revert rejeita escrita sobre versão que mudou (não sobrescreve o agente).

## IPC e CLI

Comandos `design_create|list|get|page_add|artboard_add|artboard_update|artboard_revert|artboard_approve|artboard_reject|approve_all|comment_add|comment_resolve`, com `{args:{camelCase}}`. Mutações devolvem o `Design` completo. Evento `design-changed {designId}` atualiza o painel ao vivo.

CLI: `ags design create|list|get|page add|artboard add|update|comment|approve|reject`.

## Segurança: o HTML nunca é confiável

Cada prancheta renderiza em `iframe` com `sandbox="allow-scripts"` (sem `allow-same-origin`) e `srcdoc` com CSP `default-src 'none'`, estilos inline e imagens `data:`, `form-action 'none'` e `base-uri 'none'`. Sem rede e sem acesso ao app; o iframe só fala com o painel por `postMessage` (seleção de elemento). No backend o HTML tem limite de tamanho e nunca é executado. No prompt de construção o HTML é escapado e truncado.

## Fora do escopo

Preview real do app em dev server por worktree e compartilhamento por link ficam para a etapa seguinte.
