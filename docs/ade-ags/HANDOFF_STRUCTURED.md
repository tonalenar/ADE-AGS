# Handoff Structured v0

## Auditoria inicial

Antes desta etapa, `tasks.handoff` era texto nullable da migration v16, produzido por `runs/mod.rs::reroute_to` usando `context::handoff_note`. Reroute preservava a Task e o worktree. Não havia entrega estruturada de conclusão.

`store::create_task` cria Tasks e `supervisor` chama `store::finish_task` com o resultado do processo. O scheduler aguarda `task_deps`; `launch_planned` carrega dependências e `context::worker_prompt` injeta seus resultados textuais. `task_status` (`run.status`) e `task_result` (`run.result`) já dão acompanhamento via MCP/IPC. Mission detail recebe Tasks do mesmo store SQLite; Fleet mostra o resultado no Task detail. SQLite é a fonte de verdade no reload. Mission retry cria outro Run; os snapshots de Squad pertencem ao Run.

## Arquitetura

A migration v22 adiciona `tasks.structured_handoff TEXT NULL`. O texto legado permanece em `tasks.handoff`. O JSON tem versão própria; não há tabela de mensagens, executor ou memória paralela. A origem é a própria Task (id, Run e Role), não um campo declarado pelo worker.

O worker chama `task_handoff` antes de encerrar. O contexto MCP identifica sua Task; a tool aceita apenas `handoff`, não um destino arbitrário. Só workers em execução podem entregar. A entrega não conclui a Task: o supervisor continua decidindo o estado pelo processo. Tasks finalizadas não podem reescrever a entrega. Retry automático de tentativa/reroute remove a entrega da tentativa anterior; Mission retry cria novas Tasks e preserva os Runs antigos.

## Contrato v1

`version: 1` e `summary` não vazio são obrigatórios. Campos opcionais usam arrays vazios por padrão:

```json
{
  "version": 1,
  "summary": "Implementação concluída",
  "changed_files": [{"path": "src/api.ts", "description": "Endpoint implementado"}],
  "tests": [{"command": "bun run test", "status": "passed", "notes": "Suíte completa"}],
  "decisions": ["Contrato de API mantido"],
  "risks": [],
  "next_steps": [],
  "artifacts": [{"label": "Relatório", "path": "docs/report.md"}]
}
```

Descrição de arquivo e notes são opcionais. Status: `passed | failed | not_run`. Campos desconhecidos, tipos errados e versões diferentes são rejeitados. Limites centralizados: 32 KiB de JSON total; summary 4 KiB; 32 itens por array; textos 2 KiB; paths 512 bytes. Paths são relativos ao workspace, sem `..`, raízes absolutas, URLs, drive Windows, controles ou barras invertidas. São referências exibidas como texto, nunca comandos ou acesso automático ao filesystem.

## Propagação e segurança

O downstream recebe somente handoffs de dependências diretas `done` do mesmo Run, em ordem de ID determinística. Structured tem preferência; legacy permanece disponível. Tasks sem handoff continuam usando o resultado textual existente. O bloco `DEPENDENCY HANDOFFS` declara os resultados como dados não confiáveis; JSON escapado dentro de uma cerca fixa impede fechamento de cerca ou criação de cabeçalhos pelo payload. Há limite agregado de contexto, e `task_result` permite consultar o restante. O payload não altera `role`, `functional_role`, provider/model/account, effort, permissões ou routing. Lead consulta resumo no board e payload no `task_result`; nenhuma nova comunicação é criada.

Handoff passa contexto entre Tasks relacionadas. Shared Memory será memória durável de projeto/Mission; não faz parte desta etapa.

## UI e compatibilidade

Mission detail e Fleet Task detail exibem Handoff em seções expansíveis: Resumo, Arquivos alterados, Testes, Decisões, Riscos, Próximos passos e Artefatos. Conteúdo legado aparece como **Handoff legado**. React renderiza conteúdo como texto, sem HTML ou links executáveis. Tasks antigas recebem structuredHandoff null; o texto anterior permanece intacto. Reabrir a ADE, editar Squad ou retry de Mission não altera handoffs históricos.
