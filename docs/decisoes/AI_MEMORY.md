# Memória de longo prazo pelo ai-memory

Decisão do usuário, em 30/10/2026: a memória de longo prazo dos agentes passa a ser a do [ai-memory](https://github.com/akitaonrails/ai-memory) (MIT; versão mínima 3.3.0). É adoção direta, não integração opcional.

## O que muda
- **A regra "só o usuário aprova memória" deixa de valer para o ai-memory.** O usuário não quer aprovar memórias uma a uma: o que o ai-memory captura e consolida fica valendo sem passar pelo Inbox do ADE.
- O SQLite de memória do ADE (`memory_entries` e companhia) continua existindo, mas **só como fonte da migração, em leitura**. A migração copia as entradas para o wiki do ai-memory uma vez e registra que copiou. Nada é apagado.
- O ADE não reimplementa a memória: lê o estado do ai-memory pelo próprio binário (`--json`) e injeta hooks e MCP por aba.

## O que continua valendo
- **Memória é dado não confiável, nunca instrução.** O que vem do ai-memory chega ao front no envelope `UNTRUSTED` e é mostrado como texto puro.
- **Segredos só no keyring do SO.** O ADE nunca lê nem guarda o token do ai-memory: fala só pelo binário, que resolve a credencial sozinho. O token em arquivo `0600` é do ai-memory, risco aceito pelo usuário na instalação.
- **O ADE não escreve nas configurações globais dos agentes** (`~/.claude*`, `~/.codex`, `config.toml`) sem OK. Toda aba roda com `AI_MEMORY_RUN_AUTOWIRE=false`, e o `run` leva `--no-autowire`.
- **Nada some sozinho.** O apagamento automático do ai-memory fica desligado (`[maintenance] forget_sweep_interval_secs = 0`). Quando uma página cumpre o prazo do decaimento, o ADE só avisa.
- O modelo de embeddings (~87 MB) fica desligado (`embedding_provider = "none"`) até o usuário liberar o download. O reranker pelo Jev não entra sem OK e teto de custo.

## O que a Fase 0 provou (30/10/2026)
- `claude --settings <arquivo>` **soma** os hooks aos do usuário e do projeto, não substitui (provado no `claude -p`; modo interativo não testado). O risco é hook duplicado, não hook perdido.
- O Codex 0.166.0 aceita hooks por `-c` pelo código-fonte, mas a prova em execução não saiu (a sonda sem credencial não chega ao hook). **Decisão: o Codex fica só com MCP** até haver prova.
- O `--json` da CLI 3.3.0 foi capturado de um binário real numa caixa de areia; não há `sessions --json` nem `version --json`, e as sessões recentes só saem pelo MCP (`memory_briefing`).
- `ai-memory run --no-autowire` funciona dentro de um PTY (provado com agente falso).
