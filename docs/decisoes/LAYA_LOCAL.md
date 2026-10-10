# Laya local em modo sombra

A fase 0 mede se um modelo de decisão tipado (Laya, Apache-2.0, o mesmo `POST /v1/systemone` do TypeSafe Jev) concordaria com as heurísticas que a ADE já usa. **A heurística continua decidindo.** O provedor só é consultado em segundo plano e a comparação vai para o log. Desligado, que é o padrão, não há nenhuma chamada.

O Laya não guarda a memória do projeto. Isso continua em `~/.ags/memory`, com SQLite e a projeção Markdown de sempre.

## Instalar o `laya-serve` no Windows

O servidor fala o protocolo do Jev em `http://localhost:8000`. Para texto em português, o modelo da ADE é `multilingual`. Ele lê cerca dos primeiros 1.024 tokens de cada pergunta; a ADE manda o `state` já cortado e usa menos de 20 opções.

A primeira carga do checkpoint é lenta. Com o timeout padrão de 800 ms, o botão "Testar conexão" pode falhar até o modelo estar na memória. `LAYA_PRELOAD=1` carrega na subida. Para um teste manual, dá para subir o timeout nos Ajustes; o caminho quente não faz retry.

### pip

No PowerShell, com Python 3:

```powershell
py -m pip install "laya[serve]"
$env:LAYA_HOST = "127.0.0.1"
$env:LAYA_PORT = "8000"
$env:LAYA_DEVICE = "cpu"
$env:LAYA_PRELOAD = "1"
$env:LAYA_DEFAULT_MODEL = "multilingual"
laya-serve
```

`LAYA_HOST=127.0.0.1` deixa o serviço só nesta máquina. Sem `LAYA_API_KEY`, o servidor não exige chave (o guia upstream avisa para definir uma chave se a porta sair do localhost). Se definir `LAYA_API_KEY`, cole a mesma chave nos Ajustes: ela vai para o cofre do Windows (Gerenciador de Credenciais), não para o SQLite.

`LAYA_THREADS` pode limitar os threads do torch ao número de núcleos físicos.

### Docker

No repositório upstream da Laya, a partir da raiz:

```powershell
$env:LAYA_DEVICE = "cpu"
docker compose -f compose.yaml -f compose.http.yaml up --build laya-serve
```

O compose documentado publica a porta em `127.0.0.1:8000` (`LAYA_BIND_ADDRESS`, padrão `127.0.0.1`; `LAYA_PORT`, padrão `8000`). A URL na ADE continua `http://localhost:8000`. GPU NVIDIA usa também `-f compose.cuda.yaml`, como no `docs/docker.md` do upstream.

## Ligar o modo sombra

1. Abra **Ajustes → Decisões (experimental)**.
2. Escolha o provedor: **Nenhum**, **Laya local**, **Laya Studio** (`https://api.laya.studio`) ou **Jev** (`https://api.typesafe.ai`). O cliente HTTP é o mesmo; mudam a URL e a chave. Cloudflare Clef existe só como variante futura no código, sem cliente e sem item na tela.
3. Confira a URL, o modelo (`multilingual` para pt-BR) e o timeout.
4. Se o servidor exigir chave, digite-a e salve. Para trocar, digite outra. Para apagar, marque "Apagar a chave do cofre".
5. Ligue **o modo sombra** e, um de cada vez, o ponto que quer medir.
6. Salve. **Testar conexão** usa o que já está salvo: manda um `noul` mínimo (a Laya não tem `GET /v1/models`) e mostra a latência ou o erro.

Cada ponto fica atrás da própria flag. A mesma proposta não é consultada de novo por uma hora.

## Como ler o relatório

Na mesma seção, **Atualizar relatório** mostra, por ponto:

- taxa de concordância, só entre as respostas que voltaram sem erro;
- latência p50 e p95;
- taxa de erro e taxa de timeout (timeout também conta como erro);
- discordâncias: hash do `state`, decisão da heurística e decisão do provedor. O texto da proposta não aparece.

**Exportar CSV** grava `decision-shadow.csv` com as mesmas linhas. A tabela SQLite é `decision_shadow_log`. Ela guarda no máximo 30 dias ou 50 mil linhas, o que encher primeiro. A migração só cria a tabela: não sobe a versão do schema e não dispara o backup por `VACUUM`.

## Quando promover o Laya de sombra para ativo

Ainda não há interruptor de promoção. Só vale discutir isso depois de uma amostra real, com os critérios todos juntos:

- concordância **≥ 90%** no ponto, nas respostas sem erro;
- p95 **abaixo** do tempo que a heurística daquele ponto já gasta, mais o custo que você aceita (no caminho local, a heurística é barata; 800 ms de timeout já é o teto configurado);
- taxa de erro e de timeout baixas o bastante para não esconder a amostra;
- revisão manual das discordâncias (pelo hash e pelas duas decisões, sem o texto).

Promover não troca o arquivo da memória. A memória persistente segue em `~/.ags/memory`.
