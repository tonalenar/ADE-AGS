# Autocompact de contexto pela ADE

Decisão do usuário, em 12/11/2026: "implementar o autocompact na ADE, exatamente como funciona no Claude Code/T3 Code: quando chegar em certo contexto, a própria ADE realiza o auto compact sozinha. Isso em todos os agentes." O usuário pediu o recurso **ligado**.

## O que a regra de ouro 2.3 dizia, e o que ela quer dizer
A §2.3 do `AGENTS.md` dizia "Só o usuário … faz purge/compact". Ela vem da memória: o IPC recusa `memory.compact` e `workspace.restore` para qualquer agente (`ipc/mod.rs::agent_maintenance_error`, `authz.rs`), porque compactar a **memória** apaga ou reescreve dados do usuário. Essa regra **continua valendo e não muda**.

**Compactar o contexto de uma conversa é outra coisa.** O contexto é a janela de trabalho do agente; compactá-lo resume o histórico dentro da própria sessão e não apaga a memória, o transcript nem nenhum dado do usuário (o Claude Code e o Codex gravam o resumo e mantêm o registro). O autocompact de contexto é um pedido explícito do usuário e fica **sob o controle dele pela configuração**: liga e desliga global e por agente, e o limiar em %, em Configurações → Chat → Autocompact de contexto.

Por isso o `AGENTS.md` passou a distinguir os dois: purge/compact **da memória** é só do usuário; a compactação **de contexto** acontece só quando o usuário a deixou ligada, e o agente nunca a liga nem muda o limiar por conta própria (a configuração só se altera pela tela).

## Como funciona (modelo do T3 Code e do Claude Code)
- **Medida:** tokens usados ÷ janela do modelo, lidos dos eventos de uso de cada agente.
- **Limiar:** padrão de 83% da janela, o ponto em que o Claude Code compacta sozinho numa janela de 200k (200k − 33k de reserva = 83,5%). Configurável de 50% a 95% por agente.
- **Quando:** só ao **fim do turno**. Nunca no meio de um turno, nunca com pedido (aprovação, pergunta) pendente, e a mesma ponta de contexto só é tentada uma vez. A medida de antes da última compactação não dispara de novo.
- **Quem compacta:** o comando **nativo** do agente. Se o agente já compacta sozinho (Claude Code), a ADE **não duplica**: garante o limite da sessão (a janela de auto-compact calculada do limiar, só quando a pessoa escolheu um % e a janela do modelo é conhecida) e reflete os eventos dele. Se a flag de auto-compact dele estiver desligada (`autoCompactEnabled: false` no `.claude.json` ou `DISABLE_AUTO_COMPACT` no ambiente), a ADE assume e manda o `/compact`.
- **Na linha do tempo:** "Compactando contexto…" enquanto roda e "Contexto compactado 182k → 42k tokens" no fim (só o "antes" quando o agente não informa o "depois"), com o gatilho (pelo agente, a seu pedido, autocompact da ADE). O composer ganha o medidor de contexto, com a marca do limiar.
- **Mensagens durante a compactação** vão para a fila do composer (e `Busy` para o envio direto e a fila entre agentes) e saem quando o aviso fecha.
- **Agente sem medida de contexto ou sem compactação pelo protocolo** fica desligado, com o motivo na tela. Nada é inventado.

## Terminais (PTY) e missões
- A ADE **nunca digita num terminal** para compactar (regras de ouro 2.1 e do Vigia: nunca escrever num terminal trabalhando, e a digitação do usuário é dele). O Claude Code e o Codex em terminal compactam sozinhos; a ADE lê o uso do transcript (canal estruturado) e, no Claude Code, o limite em tokens que a pessoa fixou em Compactação automática do Claude Code vale no processo.
- Missões em terminais herdam isso. Times e conversas-filhas por protocolo usam o mesmo gerenciador das conversas.
- Se um dia for seguro digitar `/compact` em terminal ocioso, precisa de nova decisão: exige canal estruturado com turno fechado, sem digitação recente do usuário, sem diálogo na tela e passar pelo `sendWhenReady`/`pokeAllowed`.

## Tabela: agente → medida → mecanismo → suportado
Fonte: `conversa/autocompact.rs::plan_table` (a tela de Configurações mostra a mesma tabela, com o motivo traduzido).

| Superfície / agente | Medida de contexto | Mecanismo | Suportado |
|---|---|---|---|
| Chat: Claude Code | `usage` por mensagem (`context_tokens`) e `modelUsage.<modelo>.contextWindow` do `result` | compacta sozinho (`autoCompactWindow` da sessão); eventos `status: compacting` e `compact_boundary` refletidos; `/compact` só se a flag dele estiver desligada | sim |
| Chat: Codex | `thread/tokenUsage/updated` (`last.totalTokens`, `modelContextWindow`) | a ADE pede `thread/compact/start` ao fim do turno; item `contextCompaction` refletido | sim |
| Chat: OpenCode, Cursor, Antigravity, ACP local | sem janela de contexto no protocolo | sem pedido de compactação (o OpenCode compacta por conta própria; no Antigravity a manual não existe por ACP) | não |
| Terminal: Claude Code | transcript (canal estruturado) | compacta sozinho; limite em tokens por env no processo | sim (a ADE não digita) |
| Terminal: Codex | transcript (canal estruturado) | compacta sozinho no limite dele | sim, só leitura (a ADE não digita) |
| Terminal: Gemini CLI (`/compress`), OpenCode, Kimi, Hermes (`compression.threshold`), Antigravity, Cursor | sem medida | compactam por conta própria | não gerenciado |
| Frota headless | — | tarefas curtas de um turno só, sem sessão para compactar | não se aplica |

## Fatos verificados e não verificados
- **Verificado localmente (sem gastar tokens):** `claude 2.1.322` emite `{type:"system",subtype:"status",status:"compacting"}` e `{subtype:"compact_boundary", compact_metadata:{trigger, pre_tokens, post_tokens?}}`, e aceita `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `DISABLE_AUTO_COMPACT` e `autoCompactEnabled` (strings do binário); o `result` traz `modelUsage.<modelo>.contextWindow` (fixtures reais). `codex 0.167.2`: o schema gerado por `codex app-server generate-json-schema` tem `thread/compact/start`, `ThreadTokenUsage` com `modelContextWindow` e o item `contextCompaction` (a notificação `ContextCompactedNotification` está obsoleta). `hermes config show` mostra a compressão de contexto ligada a 50%. `opencode 2.2.1` e o ACP não têm pedido de compactação.
- **Não verificado (exige gastar tokens):** que o `/compact` enviado como linha `user` no `claude -p` emite `compact_boundary` com `post_tokens`; que o `thread/compact/start` abre um turno e o item `contextCompaction` na ordem esperada (a ADE trata os dois casos: marca o início ao aceitar o pedido e fecha no item ou no fim do turno); a reserva de 33k do Claude Code (vem do T3 Code); o Gemini CLI (não instalado aqui).
