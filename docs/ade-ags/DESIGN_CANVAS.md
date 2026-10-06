# Canvas de Design: pranchetas, comentários e aprovação

O agente desenha a interface como **pranchetas** (artboards) HTML antes de construir. O usuário vê, comenta e edita item por item; só depois de aprovar o agente constrói.

## Fluxo: desenhe primeiro, aprove, construa

1. O agente cria um design (`ags design create`), páginas e pranchetas com HTML autocontido.
2. O usuário revisa no nó **Design** do canvas: comenta (opcionalmente em um elemento), edita o HTML/CSS ou aprova/rejeita cada prancheta (ou "aprovar tudo").
3. Os comentários do usuário são entregues ao agente dono do design (`ownerTabId`) pelo mesmo caminho do chat do canvas; ele atualiza a prancheta (nova versão) e responde.
4. **Construir aprovadas**: só pranchetas com status `approved` viram tarefas de construção (`src/features/canvas/design/buildTasks.ts`), cada uma com o HTML como referência e a instrução de trabalhar no próprio worktree. Rascunhos e rejeitadas não geram nada, e nada é construído antes da aprovação.

## Modelo de dados

`design` (workspace, missão e dono opcionais, título, status) → `page` (nome, ordem) → `artboard` (título, html, largura, altura, x, y, versão, status `draft|approved|rejected`) com histórico de versões e `comment` (autor `user|agent`, texto, seletor opcional, resolvido). Schema v37: campos `archived` e `merged_into`, com índices únicos para designs ativos. A migração consolida documentos de mesmo título/missão (ou título/workspace, sem missão), preserva todas as páginas, pranchetas, versões e comentários e mantém os IDs anteriores como aliases arquivados. Não descarta propostas divergentes.

Regras: editar conteúdo ou reverter volta a prancheta para `draft`; mover apenas x/y preserva aprovação e versão. Desfazer restaura conteúdo e dimensões sem restaurar a posição antiga. `approve_all` preserva as rejeitadas; `expectedVersion` opcional em update/revert rejeita escrita sobre versão que mudou (não sobrescreve o agente). Pranchetas novas sem coordenadas ficam à direita das existentes na página, com intervalo de 48 px, na altura da última. Coordenadas explícitas, inclusive zero, são preservadas.

## IPC e CLI

Comandos `design_create|list|get|delete|archive|page_add|artboard_add|artboard_update|artboard_revert|artboard_approve|artboard_reject|approve_all|comment_add|comment_resolve`, com `{args:{camelCase}}`. Mutações devolvem o `Design` completo. `design_create` inclui `isNew`, reutilizando o documento em tentativas repetidas. O dono de um novo design é `from` (`ADE_TAB_ID` do terminal), com `ownerTabId` como alternativa para criação pela UI. Uma nova tentativa preserva o criador anterior; só preenche dono ausente. `design_delete({args:{designId}})` exclui documento/aliases e filhos em transação, devolvendo `deleted:true`; `design_archive` mantém dados e devolve `archived:true`. A listagem omite arquivados. IDs consolidados continuam válidos para get e mutações.

Evento `design-changed {designId,isNew,deleted,archived,title,workspace,missionId}` atualiza a UI; `isNew:true` distingue criação real de reuso e permite avisar sem abrir automaticamente.

O documento também inclui `ownerAvailable` e `ownerWarning:null|"missing"|"closed"`: uma aba dona ausente não impede salvar comentários ou aprovar. A UI deve avisar que não há destino para a entrega e não tentar enviar para a aba fechada. Comentários abertos idênticos (prancheta, autor, texto e seletor) são idempotentes: `design_comment_add` devolve `commentAdded:false` em uma repetição; a UI deve evitar repetir a notificação ao agente. Um comentário resolvido não impede uma nova discussão do mesmo ponto.

CLI: `ags design create|list|get|delete|archive|page add|artboard add|update|comment|approve|reject|revert`. `ags --version` devolve JSON com `version`, `protocol`, `buildHash` e `buildDate` (segundos desde epoch; respeita `SOURCE_DATE_EPOCH`). `cli_build_status()` não recebe argumentos e compara o `ags` ao lado do executável da app: `{outdated,app:{version,buildHash,buildDate},cli:obj|null,path,reason:string|null}`. Versão/hash diferentes, data mais antiga ou metadata ausente indicam CLI desatualizado. CLI ausente, inválido ou sem resposta em 2 s retorna `outdated:true` com `reason`; a consulta ocorre fora da thread da UI.

## Segurança: o HTML nunca é confiável

Cada prancheta renderiza em `iframe` com `sandbox="allow-scripts"` (sem `allow-same-origin`) e `srcdoc` com CSP `default-src 'none'`, estilos inline e imagens `data:`, `form-action 'none'` e `base-uri 'none'`. Sem rede e sem acesso ao app; o iframe só fala com o painel por `postMessage` (seleção de elemento). No backend o HTML tem limite de tamanho e nunca é executado. No prompt de construção o HTML é escapado e truncado.

## Fora do escopo

Preview real do app em dev server por worktree e compartilhamento por link ficam para a etapa seguinte.
