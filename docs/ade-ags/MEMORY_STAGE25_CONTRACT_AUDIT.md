# Etapa 25: auditoria Backend dos contratos

Auditoria do código atual, sem alteração de schema ou migração. Os argumentos abaixo usam camelCase no `invoke` Tauri. Conteúdo, títulos, chaves e motivos de memória são dados não confiáveis.

| Ponto | IPC/backend | Tipos TS em `src/features/memory` |
| --- | --- | --- |
| 1. Contexto no QG | **confirmado**: `memory_context_metrics({runId, missionId})`, exatamente um identificador; registrado em `src-tauri/src/app/run.rs`. `snapshot_for_run` em `src-tauri/src/memory.rs` produz e sela bytes/tokens antes/depois. | **confirmado parcial**: `contextMetrics.ts`; **falta** alinhar `entriesTotal` (não retornado), `runId`, `tokenMethod`, `legacyContext` opcional e envelope de missão `{runs: [...]}`. |
| 2. Exportar/apagar/restaurar | **confirmado**: `memory_export({workspaceId})`, `db_delete_workspace({workspaceId})` com soft-delete de 30 dias e `db_restore_workspace({workspaceId})`; **cola adicionada**: alias Tauri `workspace_restore({workspaceId})` delega à restauração existente. | **falta**: contratos de exportação/lifecycle. **falta backend**: listagem de apagados; `db_list_workspaces` exclui `deleted_at IS NOT NULL`. |
| 3. Rascunhos | **confirmado**: `memory_agent_drafts({workspaceId})`, `memory_promote_draft({workspaceId,draftId})`, `memory_discard_draft({workspaceId,draftId})`. Limite pendente `PENDING_MAX=32`, promoção vira proposta, nunca aprovação. | **falta**: tipo e wrappers para rascunhos. |
| 4. Duas marcas | **confirmado**: classificação independente em `src-tauri/src/memory/review.rs`, com teste de ambas simultaneamente; resumo de revisão registrado. | **confirmado**: `MemoryReviewItem.duplicateOf` e `.contradicts` em `types.ts`. |
| 5. Busca/filtros/fonte/uso | **confirmado parcial**: `memory_query({workspaceId,missionId,cursor,limit,filter})`, paginação por cursor; `memory_verify_source`, `memory_workspace_stats`. **falta**: filtros por decisão pendente/aprovada/rejeitada, marcas e TTL vencido. | **confirmado**: `MemoryPage.nextCursor`. **falta**: filtro/query, verificação, stats e campos `sourceFactId`, `lastVerified`, `ttlDays`, `timesUsed` de `MemoryEntry`. |
| 6. Memória na tab | **confirmado**: `memory_index({workspaceId,missionId?})` registrado. | **confirmado**: `tabMemory.ts` e `Tab.memoryBlock?: boolean`; flag ausente é desligada. Nenhuma escrita em CLAUDE.md/AGENTS.md nesse fluxo. |

## Formatos disponíveis

- Métrica por Run: `{runId,beforeBytes,afterBytes,tokensBefore,tokensAfter,commit,entriesUsed,tokenMethod,legacyContext?}`. Run sem snapshot retorna erro `Run snapshot unavailable`; missão retorna `{runs: []}` se não há medições. Exibir sem dados nesses casos. Zero em snapshot realmente medido é diferente de ausência. Snapshots antigos usam estimativa do texto selado e `legacyContext: true`; não medem retrospectivamente a redução por índice.
- Exportação: `{path,entries,revisions,deletedAt,deleteAfter,memoryUsage}`. Timestamps Unix em segundos. `memoryUsage` tem `{timesUsed,entriesUsed,runsUsingMemory,method: "selected_in_run_snapshot"}`; seleção no snapshot não comprova leitura posterior pelo agente.
- Rascunhos: array `{id,scope,missionId,proposal,actorKind,createdAt,status:"agent_draft"}`; **proposal é string JSON**, não objeto. Promoção retorna `MemoryProposalResult`. Lista limitada a 256 rascunhos; não usar seu tamanho como contagem total ilimitada.
- `MemoryFilter` aceita somente `{query?,kind?,status?,used?}`, com `deny_unknown_fields`. Status atual é `active|inactive|deleted`, não status da revisão. Escopo é escolhido por `missionId` (null = workspace; ID = missão). Não enviar filtros inexistentes. Reiniciar cursor ao alterar filtros.
- Verificar fonte: `{entryId,filePath?:string|null,commit?:string|null}` -> `{runExists,taskExists,fileExists,commitExists,lastVerifiedChanged:false}`. Resultados de existência são boolean ou null. Somente revisão aprovada; caminho relativo validado e hash hexadecimal. A verificação é só leitura, não atualiza `lastVerified`.
- `memory_set_verification` existe separadamente, mas altera metadados; o botão conferir fonte não deve chamá-lo automaticamente.

## Segurança e limites da revisão

Confirmado: nenhuma ocorrência de `dangerouslySetInnerHTML` ou `innerHTML` em `src/features/memory` no momento da auditoria. O backend serializa dados, não os transforma em HTML seguro; renderizar por texto React, inclusive `proposal` após JSON.parse. Marcas são heurísticas e nunca autorização para aprovar. Os testes existentes de memória usam `database::test_db`, sem abrir o banco real. `memory_verify_source` limita caminhos ao repositório e executa apenas `git cat-file -e` com hash validado.

A revisão das novas telas depende do código aprovado pelo canvas. As lacunas de filtros e listagem de apagados exigem lógica nova, além de um comando sobre função existente; foram encaminhadas ao Orquestrador para decisão de escopo.
