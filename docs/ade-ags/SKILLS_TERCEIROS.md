# Skills de terceiros embutidas: `jev-sim-use` e `agent-desktop`

A ADE AGS traz instaladas duas skills de computer use de outros autores, junto com a `ags-orchestrator`:

| Skill | Upstream | Versão fixada | Licença | O que ensina |
|---|---|---|---|---|
| `jev-sim-use` | [Ryu0118/jev-sim-use](https://github.com/Ryu0118/jev-sim-use) | tag `0.4.2`, commit `8aea477` | MIT | a CLI `jev-sim-use`: o Jev navega no simulador iOS ou num Android por cima do `sim-use` (árvore de acessibilidade) |
| `agent-desktop` | [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop) | tag `v1.2.0`, commit `2b0a733` | Apache-2.0 | a CLI `agent-desktop`: lê e opera apps do Mac pela árvore de acessibilidade, sem modelo dentro |

## O que vem e o que não vem

- **Vem**: o texto da skill (`SKILL.md`, as `references/` e o `LICENSE` do upstream), em `skills/<nome>/`, empacotado como recurso (`tauri.conf.json`) e instalado ao abrir o app (`skills/bundled.rs`, `BUNDLED`).
- **Não vem**: os binários `jev-sim-use`, `sim-use` e `agent-desktop`. Instalá-los mudaria o instalador e rodaria código de terceiros na máquina do usuário. A skill manda o agente avisar a pessoa e dar o comando de instalação, sem instalar nada sozinho. Empacotar os binários é uma decisão em aberto do usuário.
- **Não vem**: o `jev-desktop` do repositório do agent-desktop. Ele precisa de um clone e da chave do Jev no ambiente.

## Integridade

`skills/vendor.lock.json` guarda, para cada skill:
- repositório, tag e commit (40 caracteres);
- versão (`<upstream>+ade.<n>`);
- para cada arquivo, a origem e o SHA-256 do original.

O `SKILL.md` embutido é o original com duas coisas a mais, que saem com um corte simples para conferir o hash:
1. a linha `version: "<versão>" # ade-ags` no frontmatter, que o app compara para decidir se atualiza;
2. o bloco `<!-- ADE AGS:BEGIN -->` … `<!-- ADE AGS:END -->`, que diz como a skill convive com o caminho nativo.

| Conferência | Onde |
|---|---|
| Hash de cada arquivo, versão do frontmatter × lock, bloco presente | `skills/test.rs::as_skills_de_terceiros_conferem_com_o_hash_do_upstream_e_a_versao_do_lock` (roda no CI com o `cargo test`) |
| O mesmo, offline, à mão | `bun scripts/vendor-skills.ts --check` |

## Atualização

- **No usuário**: a skill se atualiza quando a versão do app traz uma versão nova da skill. Ao abrir, o app compara a versão instalada com a empacotada e troca a pasta com dois `rename`: quem ler a skill no meio vê a velha ou a nova, nunca metade.
  - Com algum terminal aberto (agente ou missão), a troca fica para a próxima abertura (`crate::terminal::live_pty_count`).
  - Se a pessoa apagou a skill, ela não volta; só uma versão nova é oferecida de novo.
  - O app **não** baixa a skill do GitHub sozinho. Uma skill é instrução para todos os agentes: puxar o texto do upstream sem revisão daria ao upstream um canal direto de instrução para os agentes do usuário.
- **No repositório** (manutenção):
  1. Liste as tags novas, sem baixar nada além da lista: `bun scripts/vendor-skills.ts --outdated`.
  2. Atualize uma skill: `bun scripts/vendor-skills.ts --update <nome> --tag <tag> --commit <sha>`. O script:
     - clona a tag sem checkout (`--filter=blob:none`) e lê só os arquivos do lock com `git show`;
     - exige que a tag aponte para o commit informado e, senão, não copia nada;
     - recalcula os hashes e preserva o bloco da ADE AGS.

     Nada do clone é executado (sem hooks, sem scripts).
  3. Revise o diff, sobretudo o `SKILL.md` e se o bloco da ADE AGS ainda faz sentido. Abra o PR.

## Ligada para todos os agentes

As duas nascem com "Ativa em todos os agentes" ligada (painel de Skills → a skill → a chave no cabeçalho).

- **Ligada**: a skill é montada (symlink) na pasta de skills de toda aba de agente aberta, sem anexar projeto a projeto.
- **Desligada**: sai de todas as pastas na hora. Uma atualização não religa: só a primeira instalação liga.
- **Armazenamento**: `settings` → `skills.always_on` (JSON com ids).
- **Código**: `skills/always.rs`, chamado de `links::desired_skills_for_link_dir`.
- **Comandos Tauri**: `list_always_on_skills` e `set_skill_always_on`.

Cada agente lê a skill na sua pasta (`agents/registry.rs`, `skills_dir`): `.claude/skills`, `.agents/skills` (Codex, Gemini, OpenCode, Kimi, Antigravity) e `.cursor/skills`. O Hermes não recebe skills do projeto. Quem já tinha a skill instalada à mão em `~/.agents/skills` ou `~/.codex/skills` passa a ver duas cópias, a global e a do projeto. A do projeto tem o bloco da ADE AGS. A ADE não mexe na global: apagá-la é decisão do usuário.

## Como convivem com o caminho nativo

O caminho nativo (`ags sim act`, `ags desk act`, `ags portal act` e as tools MCP `sim_act`, `desk_act` e `browser_act`) é o único que garante:
- confirmação humana pela UI e "Sempre neste aparelho";
- privacidade dos `--fill`;
- a chave do Jev só no keyring;
- auditoria;
- um act por vez.

Por isso as skills de terceiros entram como complemento:

| Necessidade | Use |
|---|---|
| Atingir um objetivo no simulador iOS | `ags sim act` / `sim_act` |
| Controlar um iPhone/iPad físico compartilhado com a ADE | `ags device` / `device_list`, `device_shot`, `device_action` |
| Ler a árvore de acessibilidade do simulador, elementos fora da tela, valores exatos | `jev-sim-use exec ui` (local, só leitura) |
| Android, simulador que o `sim act` não alcança, ou a pessoa pediu jev-sim-use pelo nome | `jev-sim-use "<objetivo>"`, nunca com um act rodando no mesmo aparelho. Nunca definir, pedir ou exportar `TYPESAFE_API_KEY` |
| Atingir um objetivo na tela do Mac | `ags desk act` / `desk_act` |
| Mapear ou conferir um app do Mac | `agent-desktop snapshot` / `find` / `get` / `is` (só leitura) |
| Clicar ou digitar com agent-desktop | só quando a pessoa pediu agent-desktop pelo nome e o `desk act` não dá conta; nunca `--headed` sem permissão |
| Navegador do canvas | `ags portal act` / `browser_act` |

Com o Jev ligado em Ajustes → Decisões, todo `act` acima usa o Jev do painel. O `jev-sim-use` usa o Jev por conta própria, mas só com a chave no ambiente, e a ADE não a coloca lá. A regra fica no bloco "In ADE AGS" de cada skill e na seção "Computer use with Jev" da `ags-orchestrator`.

### O que não foi feito, e por quê

- **Proxy local do Jev para o `jev-sim-use`.** A ADE poderia servir `POST /v1/systemone` em `localhost` e pôr a chave do keyring, para o `jev-sim-use` usar o Jev do painel com `--base-url`. Não foi feito: qualquer processo local gastaria a cota por esse proxy. Exigiria um token por aba e a decisão do usuário.
- **Impor por código as regras de uso.** A ADE não intercepta a CLI de terceiros. As regras ("só leitura", "nunca a chave") são instrução da skill, não barreira. As garantias duras continuam no caminho nativo.
