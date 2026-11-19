# Contas múltiplas por agente: identidade, seletor e limites

Referência: o modelo de "instâncias de provedor" do T3 Code (`pingdotgg/t3code`): selo de iniciais com cor, um ícone por instância no seletor, aviso ao ter várias contas e limites por instância. A ADE já isolava cada conta por perfil (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME`, HOME no Antigravity do macOS); este trabalho cuida de **como a pessoa vê e escolhe** cada conta. Estado: fases 1 a 5 entregues; **fases 6 e 7 (login real nas contas do usuário) não foram feitas**.

## O que cada fase entregou

| Fase | PR | O que mudou |
|---|---|---|
| 1. Identidade | #390 | `display_name` e `accent_color` em `agent_accounts` (aditivas, padrão NULL); conta principal em configuração; comando `account_identity_set`; selo, paleta e diálogo "Personalizar" |
| 2. Seletor | #391 | um ícone por conta no trilho do `AgentModelPicker`, com selo; `<select>` do rodapé mantido |
| 3. `AccountRef` | #392 | a escolha de conta vira um tipo (`conta` ou `pool`), sem a mistura de `pool:<nome>` na string |
| 4. Limites | #393 | barra curta de limite por conta no trilho |
| 5. Adicionar | #394 | botão "+" no trilho abre o `AddAccountDialog`; aviso ao adicionar a 2ª conta de Claude/Codex |

## Dados

- **Colunas novas** de `agent_accounts` (`database/schema.rs`, via `has_column`, nada é reescrito):
  - `display_name TEXT`: o nome que a pessoa vê. O `name` continua sendo o **nome da pasta** do perfil e não muda.
  - `accent_color TEXT`: o **nome de um token do tema** (`blue`, `violet`, `orange`, `green`, `pink`, `yellow`, `cyan`, `red`), nunca um hex.
- **Conta principal** (`system:<agente>`) não é linha da tabela. A identidade dela fica na configuração, na chave `accounts.system_identity.<agente>` (JSON `{displayName, accentColor}`). Sem valor, o nome é "Principal" (`accounts.principalName`).
- Validação no backend (`accounts/identity.rs`): nome aparado, até 40 caracteres, sem caractere de controle; cor só da lista `ACCENT_TOKENS`. Valor corrompido na configuração vira o padrão.
- Comando Tauri: `account_identity_set(accountId, displayName, accentColor)`; texto vazio limpa. Wrapper em `src/features/accounts/ipc.ts`. Não há comando na CLI `ags` nem tool MCP (só interface).
- Fingerprint do schema reconhecido em `docs/decisoes/fingerprints/`, com `semPerdaDeDados`.

## Selo e cor

- `src/features/accounts/accountIdentity.ts`: `ACCOUNT_COLORS` (token → `var(--color-<matiz>-700)` com texto `gray-50`), `accountInitials` (porte de `providerInstanceInitials`: `AN`, `A2`, `CH`, `TC`, `CP`/`CW`), `accountDisplayLabel` e `shouldShowAccountBadge`.
- Regra de exibição do selo (igual à do T3): a conta tem cor **ou** há mais de uma conta do mesmo agente. Uma conta só e sem cor = sem selo.
- O fundo usa o degrau 700 de cada matiz: em todos o texto claro passa de 4,5:1, então o contraste não depende de cálculo em tempo de execução. Os valores são escritos por extenso no código para o Tailwind emitir cada variável (confirmado no CSS do `vite build`).

## Seletor de modelo

- `src/features/chat/pickerRail.ts` monta o trilho a partir do roster (contas que existem e se têm login) e da loja de contas (`useAccountsStore`, de onde vêm nome e cor). A chave de cada item é `agente` ou `agente::conta`.
- Escolher o ícone de uma conta e depois um modelo muda **agente e conta juntos**. O ✓ só aparece na conta em uso.
- Conversa aberta (`showAccount=false`, a conta não muda): um ícone por agente, sem selo.
- Conta sem login: ícone apagado e o nome acessível avisa.
- Pools continuam só no `<select>` do rodapé; não viram ícone.
- `AccountRef` (`accountRef.ts`): `{kind:"account", agentId, accountId|null}` ou `{kind:"pool", agentId, pool}`. Só o seletor o usa por dentro. Na fronteira (preferências salvas, `addTab`, backend) o valor continua `id | "pool:<nome>" | null`; `accountRefFromWire` e `accountRefToWire` fazem a ida e a volta.

## Limites

- `pickerLimits.ts` usa as mesmas leituras e a mesma regra do cartão "Limites de uso" do Resumo (`readClaude`, `readCodex`, `readAntigravity`, `readAgy`, `headlineOf`, `accountKeyOf`): a janela mais gasta; sem leitura, sem login, janela já renovada ou agente sem fonte de cota = sem barra.
- A barra aparece só em agentes com mais de um ícone.
- Ao abrir, pede a cota **sem forçar** só das contas do agente da aba que ainda não têm leitura. Para Claude isso pode levantar a TUI para ler o `/usage`.

## Adicionar conta e aviso

- O botão "+" fica no pé do trilho, para o agente da aba, só em agentes que aceitam várias contas (`account_capable_agents`) e quando a conta pode ser escolhida (não numa conversa aberta). O diálogo (`AddAccountDialog`) fica no seletor, fora do popover, para o login continuar vivo quando o seletor fecha. O login usa o `LoginTerminal` existente.
- `MultipleAccountsNote`: nota ao adicionar a 2ª conta de **Claude ou Codex** (já existe uma conta do mesmo agente com login). Não bloqueia; diz que cada conta tem a própria cota e que a ADE não soma nem divide limites.

## Limites e pendências

- **Não feito:** fases 6 e 7 (login real e prova de ponta a ponta com as contas do usuário).
- **Não verificado visualmente:** nenhuma das telas tem captura (selo, paleta, diálogo, trilho com selo e barra, botão "+").
- A conta ativa de uma conversa aberta continua sem troca pelo trilho: a sessão mora na pasta da conta.
- Os chamadores do seletor (`NewConversation`, `ChatModeSetting`, `LinkAgentForm`) ainda passam a conta como string; migrá-los para `AccountRef` fica para depois.
