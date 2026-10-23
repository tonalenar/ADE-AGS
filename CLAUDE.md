# CLAUDE.md

As instruções deste projeto ficam em **[AGENTS.md](AGENTS.md)**, a fonte única para todos os agentes. Não duplique regras aqui: mude o AGENTS.md.

@AGENTS.md

## Só para o Claude Code

- Responda sempre em PT-BR, inclusive nas mensagens de progresso entre ferramentas.
- Antes de mexer num tópico, leia o arquivo dele em `docs/agentes/` (índice na §4 do AGENTS.md); só o AGENTS.md é carregado automaticamente.
- Memória persistente: fatos do projeto que valem para qualquer agente vão para o `AGENTS.md` ou para o arquivo do tópico em `docs/agentes/`; a memória do Claude guarda só o estado de trabalho em andamento (PRs abertos, medições, pendências).
