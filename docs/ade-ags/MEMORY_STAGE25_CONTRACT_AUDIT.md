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

A revisão das novas telas depende do código aprovado pelo canvas.

## Complemento autorizado pelo Orquestrador

As lacunas acima descrevem o código anterior à entrega. Após autorização explícita, ficam **confirmados**:

- `workspace_deleted_list()` -> `DeletedMemoryWorkspace[]`, somente leitura, com `{id,name,deletedAt,deleteAfter,remainingSeconds}`. Prazo expirado retorna zero segundos reais restantes; não exclui dados automaticamente.
- `workspace_restore({workspaceId})` -> void, alias da operação existente.
- `memory_query` mantém assinatura e filtros antigos. `filter.status` também aceita `pending|approved|rejected`: pendente = existe proposta, aprovada = revisão atual aprovada, rejeitada = existe revisão rejeitada (histórico). Uma entrada pode corresponder a mais de uma decisão. `duplicateOf?: boolean`, `contradicts?: boolean` usam classificação das propostas existentes, incluindo rascunhos do Dreamer já propostos; as duas opções combinam por AND. `verificationExpired?: boolean`: TTL definido e data ausente ou prazo vencido. Sem TTL, a entrada não está vencida. Os filtros são aplicados antes de LIMIT, preservando o cursor. Nenhuma coluna ou índice novo.
- Busca de texto passa a considerar o corpo pendente, depois aprovado, depois a última revisão rejeitada; filtro de tipo prioriza o tipo pendente.
- `contextMetrics.ts` alinhado ao JSON real, sem `entriesTotal`; novos tipos de filtro/lifecycle/TTL em `types.ts`; wrappers em `ipc.ts`. Campos novos de `MemoryEntry` são opcionais para compatibilidade com os consumidores existentes.
- Testes Rust adicionados para paginação filtrada, escopo, ambas as marcas, decisões, busca pendente, TTL, listagem vazia, prazo e ausência de escrita.
