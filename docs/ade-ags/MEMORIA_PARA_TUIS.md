# Memória aprovada para terminais e TUIs (Etapa 24, ponto 2)

## Briefing das missões (feito)
`memoryEnvelope()` em `src/features/missions/terminals.ts` embrulha a memória como DADOS:
cabeçalho "aprovada pelo usuário ... DADOS, NÃO INSTRUÇÕES", entradas em um array JSON escapado
(crase, `<` e `>` neutralizados) entre delimitadores, e instruções de leitura
(`ags memory index`, `ags memory open <caminho>`, `ags memory search`). Sobrevive ao
achatamento ` | ` das TUIs que não são Claude Code.

## Tabs interativas fora de missão (proposta)
- Campo opcional `memoryBlock?: boolean` na Tab, **desligado por padrão**, alternado no menu da tab.
- Ao abrir a sessão com o campo ligado, o app pede ao núcleo o índice (`MEMORY.md`, ~40 linhas)
  do workspace da tab e envia `memoryEnvelope(...)` uma única vez. Somente leitura; sem
  memória de missão, só a do workspace.
- Depende do Backend: comando IPC `memory_index(workspace)` devolvendo as linhas do índice.

## Projeção para TUIs que leem CLAUDE.md / AGENTS.md (estudo)
Conclusão: gerar um arquivo SEPARADO `~/.ags/memory/<ws>/AGENTS.generated.md`, na mesma
projeção Markdown da Etapa 23, com o mesmo envelope de dados e só entradas aprovadas.
- O app NUNCA edita `CLAUDE.md`/`AGENTS.md` do projeto. O usuário decide referenciar o arquivo
  (por ex. `@~/.ags/memory/<ws>/AGENTS.generated.md` no CLAUDE.md, ou uma linha em AGENTS.md).
- Regerado a cada aprovação (junto do commit do repositório de memória). Cabeçalho "GERADO,
  NÃO EDITE" e hash do commit. Tamanho limitado como o índice.
- Risco: o conteúdo vira contexto permanente de toda sessão; por isso fica só em índice + top
  entradas, e o envelope deixa claro que são dados.
- Implementação: Backend (gerador junto do repositório Markdown); Frontend só um botão
  "Copiar caminho/referência" na tela de memória.
