# Navegador nativo do Portal (WebView2)

O Portal usa dois caminhos. O modo de desenvolvimento passa a página pelo proxy local (`src-tauri/src/preview`), com inspeção e mocks. No Windows, o modo nativo exibe um WebView2 filho sobre o Portal, sem abrir nem reutilizar o Chrome do sistema. Em macOS e Linux, links externos continuam pelo proxy porque o WebView2 nativo não está disponível.

## Sessão e perfis

- **Padrão compartilhado:** o id `default` continua usando `<dados da ADE>/portal-webview`, preservando os dados existentes e compartilhando essa sessão entre vistas que escolherem esse perfil.
- **Agentes e conversas:** cada proprietário recebe um id estável derivado do tipo e do id da conversa/agente. Os ids não expõem o caminho de origem. Perfis diferentes ficam em `<dados da ADE>/portal-webview/profiles/<id>`.
- **Perfis vazios:** o seletor na barra do modo nativo permite criar, renomear e excluir um perfil isolado. Renomear preserva o id, a pasta e a sessão. O nome e o id ficam no `localStorage` da janela ADE; cookies e dados dos sites ficam no diretório próprio do WebView2. Criar um perfil não copia dados de outro navegador. Excluir exige confirmação e limpa os dados locais do perfil; perfis associados a abas abertas ou restauráveis ficam protegidos até serem trocados para outra sessão.
- **Troca:** escolher outro perfil fecha o WebView2 daquela vista e abre a mesma URL na nova sessão. Os demais Portais continuam abertos.
- **Limites atuais:** ainda não há importação de cookies/sessões. A lista de perfis nomeados é local à janela; o diretório é persistente da ADE. Copiar cookies ao WebView2 deixaria credenciais persistidas fora do chaveiro, então a integração aguarda um desenho compatível com a regra de segredos da ADE.

## Como funciona

`src-tauri/src/real_browser/mod.rs` valida o id do perfil e escolhe sua pasta. A remoção aceita apenas IDs no formato `profile-<UUID>`, bloqueia perfis ainda usados por Portais, solta o ambiente WebView2 cacheado na thread da interface e só então remove o diretório. Se o sistema ainda mantiver arquivos bloqueados, a operação falha e o perfil continua na lista para nova tentativa. `src-tauri/src/real_browser/native.rs` cria o ambiente WebView2 para essa pasta e mantém um ambiente por perfil. Cada Portal tem sua própria janela filha e `ICoreWebView2`; retângulo, zoom, recorte visível e áreas cobertas vêm de `RealBrowserView`.

O controle do agente usa a API CDP do WebView2 dentro do processo, sem porta de depuração aberta. A ADE instala o piloto antes dos scripts dos sites, encaminha ordens e eventos pela binding `Runtime.addBinding`, e captura a página com `Page.captureScreenshot`. Os cliques, digitação e teclas pedidos pelo piloto chegam ao WebView2 via `Input.*`. O painel e o agente usam o mesmo `BrowserTab`/`viewId`; não há uma página headless paralela.

## Segurança e dados

- O perfil pessoal do Chrome, Edge ou Safari não é aberto, lido ou copiado.
- Cookies, armazenamento local e credenciais do site ficam nos diretórios do WebView2, fora do banco, dos logs e das mensagens dos agentes.
- O id enviado ao backend aceita apenas letras ASCII, números, hífen e sublinhado, com limite de tamanho; ele não pode incluir segmentos de caminho.
- A importação de sessões continua bloqueada até que o armazenamento de credenciais do fluxo respeite a regra de usar somente o chaveiro do SO.

## Referências internas

- [BrowserTab](../../src/features/browser/BrowserTab.tsx)
- [Gerenciamento de perfil](../../src/features/browser/profiles.ts)
- [Comandos do Portal](../../src-tauri/src/real_browser/mod.rs)
- [WebView2 nativo](../../src-tauri/src/real_browser/native.rs)
- [Plano de paridade do navegador T3](./T3_CODE_INTEGRACAO.md#plano-do-navegador-inspirado-no-t3-code)
