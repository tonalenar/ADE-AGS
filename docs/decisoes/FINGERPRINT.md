# Fingerprint dos tipos persistidos

**Decisão:** o schema SQLite e o protocolo IPC têm um SHA-256. Quando o hash muda, o PR precisa de um registro de reconhecimento, e o CI falha sem ele. Ideia do deepseek-harness (MIT), ponto 24 da análise.

## Por quê
- "Nenhuma migração apaga dados do usuário" e "mudança de schema IPC pede a suíte completa" eram regras de memória. Agora uma mudança nesses arquivos não passa despercebida pela revisão.
- O registro obriga quem muda a dizer **o que** mudou e, no schema, a afirmar que não há perda de dados.

## O que é fingerprintado
| Alvo | Arquivos | Exige `semPerdaDeDados` |
|---|---|---|
| `schema-sqlite` | `src-tauri/src/database/schema.rs` | sim |
| `protocolo-ipc` | `src-tauri/src/ipc/protocol.rs` | não |

- O hash é do fonte **normalizado**: sem comentários, com espaços colapsados e CRLF virando LF, mas com as strings intactas (o SQL das migrações mora nelas). Comentário e reindentação não pedem registro.
- Qualquer outra mudança de código nesses arquivos pede, inclusive a de uma função auxiliar. É de propósito: o custo de um registro é uma linha, e o de uma migração errada é o dado do usuário.
- **Fora do alvo:** os `migrate()` próprios de módulos (`decisions/log.rs`, `design.rs`, `memory/dream.rs`, `missions/messages.rs`, `testspeed/run.rs`, `peer_queue/store.rs`, `conversa/store.rs`, `chat_team/store.rs`, `canal/pending.rs`, `tab_checkpoints/store.rs`…). Eles misturam schema e lógica no mesmo arquivo, e o hash do arquivo inteiro daria registro a cada mudança. Para cobri-los, o próximo passo é o hash do schema real (`sqlite_master` depois de `migrate()` num `test_db()`), não feito.

## Como reconhecer uma mudança
1. Revise a mudança:
   - schema: é aditiva e idempotente (`has_column()`/`table_exists()`), nada é apagado, o que não migra vira `_legacy_*`, e os testes de migração passam ([BACKEND.md](../agentes/BACKEND.md#banco-de-dados));
   - protocolo: campo novo é opcional (`#[serde(default)]`), nenhum campo some ou muda de tipo sem a CLI antiga continuar funcionando.
2. Rode e commite o arquivo gerado junto com a mudança:

```bash
node scripts/fingerprint.mjs --reconhecer schema-sqlite --motivo "coluna X em Y, aditiva com has_column" --sem-perda-de-dados
```

```bash
node scripts/fingerprint.mjs --reconhecer protocolo-ipc --motivo "campo opcional Z na resposta W"
```

3. `node scripts/fingerprint.mjs` (ou `bun run check:fingerprint`) deve dizer `fingerprint ok`.

Sem `--sem-perda-de-dados`, o registro do schema é recusado. Se a mudança apaga dados, ela não deve ser feita: fale com o usuário antes.

## Formato do registro
Um arquivo por mudança em `docs/decisoes/fingerprints/<alvo>-<sha12>.json`. Um arquivo, e não uma lista única, para dois PRs paralelos não entrarem em conflito no merge.

```json
{
  "alvo": "schema-sqlite",
  "sha256": "<64 hex>",
  "data": "AAAA-MM-DD",
  "motivo": "o que mudou e por quê (≥ 10 caracteres)",
  "semPerdaDeDados": true,
  "arquivos": ["src-tauri/src/database/schema.rs"]
}
```

O check passa quando existe um registro válido com o hash atual de cada alvo. Registros antigos ficam: são o histórico das mudanças reconhecidas.

## Onde roda
- CI: passo "Fingerprint do schema e do protocolo" do job `test` (`.github/workflows/ci.yml`).
- Teste da lógica: `src/app/tests/fingerprint.test.ts`.
- O CI ignora PRs só de `docs/**`, mas uma mudança de schema ou protocolo sempre toca `src-tauri/`.
