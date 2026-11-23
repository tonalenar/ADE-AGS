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

## Adoção pelas missões e pela Frota (22/11/2026)
- Briefings de missão e snapshots da Frota consultam `search --json` com o par workspace/projeto resolvido para o cwd. O ADE injeta até 10 páginas e 6 KiB em `UNTRUSTED DATA`; se o binário/servidor faltar ou a integração estiver desligada, usa o snapshot SQLite histórico, em leitura.
- `ags memory suggest`, `swarm promote` e as gravações MCP da Frota mantêm os nomes existentes, mas gravam páginas no projeto do ai-memory. A chave gera o caminho estável da página; atualização e promoção não criam proposta no SQLite. A ADE aplica o mesmo filtro de segredos e não pede aprovação item a item.
- A escrita exige escopo único e não reservado. Se o ai-memory estiver desligado ou indisponível, a escrita falha; ela nunca volta para o SQLite.
- O Inbox continua exibindo e permitindo revisar registros antigos do SQLite. Novas gravações no ai-memory não entram nessa fila. Nenhuma linha histórica é apagada; `ai_memory/migracao.rs` continua fazendo cópia não destrutiva e purge/compact permanecem controles do usuário.

## O que a Fase 0 provou (30/10/2026)
- `claude --settings <arquivo>` **soma** os hooks aos do usuário e do projeto, não substitui (provado no `claude -p`; modo interativo não testado). O risco é hook duplicado, não hook perdido.
- O Codex 0.166.0 aceita hooks por `-c` pelo código-fonte, mas a prova em execução não saiu (a sonda sem credencial não chega ao hook). **Decisão: o Codex fica só com MCP** até haver prova.
- O `--json` da CLI 3.3.0 foi capturado de um binário real numa caixa de areia; não há `sessions --json` nem `version --json`, e as sessões recentes só saem pelo MCP (`memory_briefing`).
- `ai-memory run --no-autowire` funciona dentro de um PTY (provado com agente falso).

## Backup opcional das memórias para GitHub privado (22/11/2026)
- **Opt-in (desligado por padrão)**: a sincronização de memórias com repositório privado nasce desligada em Configurações → Memória e só envia após escolha explícita de conta git (com API) e repositório (ex.: `ade-memoria`, criado privado quando ausente).
- **Privacidade verificada por API**: a cada envio e na configuração, a ADE consulta a API do forge (`find_repo`) e bloqueia o push se o repositório for público ou se não puder confirmar que é privado.
- **Filtro de segredos e espelho separado**: páginas do `ai-memory` (escopo do projeto via `client.rs --json`, excluindo `_global`/`_profile`) e o histórico aprovado do SQLite legado (somente leitura) passam por `looks_like_user_secret` antes de ir para o espelho isolado em `<app_data_dir>/memory-sync/repo`. Páginas suspeitas são omitidas e listadas na UI; o repositório local de projeção (`~/.ags/memory/ws-<hash>/`) segue estritamente sem remote.
- **Credencial efêmera**: o token do keyring chega ao `git` apenas via `GIT_ASKPASS` loopback efêmero autenticado por nonce e host esperado, sem gravar em `argv`, ambiente persistente, URL, disco ou log.
- **Mão única e desligamento não destrutivo**: o envio é apenas ADE → remoto (importação reversa fica como trabalho futuro). Desligar interrompe envios manuais e automáticos sem apagar dados locais nem remotos.
