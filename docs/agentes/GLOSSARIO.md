# Glossário do ADE AGS

> Parte do guia de agentes. Índice e regras de ouro: [`AGENTS.md`](../../AGENTS.md).

| Termo | Significado | Onde ler mais |
|---|---|---|
| **Workspace** | pasta de projeto com seus agentes, abas, arquivos e git | — |
| **Aba / terminal** | PTY real com um agente ou um shell (`--agent bash`) | [FRONTEND.md](FRONTEND.md) |
| **Canvas** | terminais como nós; a **conexão** entre dois autoriza `peer ask/tell` | [TROCA_DE_MENSAGENS.md](TROCA_DE_MENSAGENS.md) |
| **Conversa** | um canvas salvo por projeto; trocar de conversa salva e fecha os terminais, com retomada | — |
| **Missão** | intenção durável (objetivo, pasta, estado `draft → running → done/failed/cancelled`, `done_without_delivery`) | [ORQUESTRACAO.md](ORQUESTRACAO.md) |
| **Run / Task** | tentativa de cumprir a missão / unidade entregue a um agente (DAG em `task_deps`) | [ORQUESTRACAO.md](ORQUESTRACAO.md) |
| **Orquestrador / Lead** | quem planeja e delega; **integrante / worker** executa | [ORQUESTRACAO.md](ORQUESTRACAO.md) |
| **Role** | papel funcional (`backend`, `frontend`, `qa`, `reviewer`…); não concede permissão | [ORQUESTRACAO.md](ORQUESTRACAO.md) |
| **Squad** | configuração reutilizável de lead + membros (provider/modelo/conta/Fast), congelada no Run | [ORQUESTRACAO.md](ORQUESTRACAO.md) |
| **Recruit** | agente acrescentado à equipe pelo orquestrador (`ags peer recruit`) | [ORQUESTRACAO.md](ORQUESTRACAO.md) |
| **Frota** | agentes headless em worktrees `cc/<task>`, com broker de permissão (sem resposta = negada) | [ORQUESTRACAO.md](ORQUESTRACAO.md) |
| **Andar (floor)** | cópia isolada do projeto (worktree + branch + canvas); **térreo** = o original; **aterrissar** = merge de volta | [ORQUESTRACAO.md](ORQUESTRACAO.md) |
| **Portal** | nó-navegador no canvas, pilotado pelos agentes conectados (`ags portal …`) | [JEV.md](JEV.md) |
| **Vigia** | supervisor em segundo plano que detecta agentes parados, cutuca o Orquestrador e confirma entregas (desligado por padrão) | [VIGIA.md](VIGIA.md) |
| **Laço do Codex** | o `gpt-6.1-sol` fica em "Working" emitindo raciocínio vazio; o Vigia detecta e só avisa | [VIGIA.md](VIGIA.md#laço-do-codex-vigialoopts) |
| **Cutucada (poke)** | lembrete colado pelo Vigia no terminal do lead, nunca com o agente trabalhando | [VIGIA.md](VIGIA.md#cutucada-pokeallowed-poke) |
| **Jev** | serviço de decisões tipadas da TypeSafe (`api.typesafe.ai`), que devolve rótulo + probabilidade | [JEV.md](JEV.md) |
| **Laya** | modelo de decisão tipada local e aberto, com o mesmo protocolo do Jev | [JEV.md](JEV.md#laya-local) |
| **Modo sombra** | a heurística decide e o provedor só é registrado ao lado, para comparar | [JEV.md](JEV.md#modo-sombra) |
| **Memória compartilhada** | notas de workspace/missão propostas por agentes e aprovadas pelo usuário; chegam como `UNTRUSTED DATA` | [MEMORIA.md](MEMORIA.md) |
| **Run Facts** | anotações append-only de um Run; não são memória | [MEMORIA.md](MEMORIA.md) |
| **Quadro (swarm)** | notas numeradas da missão (`ags swarm note/read`), citadas como "quadro #n" | [TROCA_DE_MENSAGENS.md](TROCA_DE_MENSAGENS.md) |
| **Handoff v1** | entrega estruturada em JSON (resumo, arquivos, testes, decisões, riscos): `ags peer deliver` no canvas, `task_handoff` na frota | [ORQUESTRACAO.md](ORQUESTRACAO.md) |
| **Dreaming** | task iniciada pelo usuário que só propõe consolidações de memória | [MEMORIA.md](MEMORIA.md) |
| **Precheck** | o que o repo e as missões anteriores já dizem sobre o objetivo, injetado no briefing | [ORQUESTRACAO.md](ORQUESTRACAO.md) |
| **Rodada de correção** | um reenvio de trabalho a um membro; teto padrão de 2 | [ORQUESTRACAO.md](ORQUESTRACAO.md#rodadas-de-correção) |
| **Hermes** | Hermes Agent (Nous Research), TUI suportada no registry | [BACKEND.md](BACKEND.md) |
| **Maestri** | app concorrente, usado só como referência de produto; não copiar código nem textos | — |
| **QG / BotPanel / pet** | painel do bot com o arcade da missão e as métricas | — |
