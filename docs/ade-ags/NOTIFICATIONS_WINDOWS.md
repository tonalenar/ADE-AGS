# Etapa 20 — ponto 1: identidade das notificações Windows

O processo configura `SetCurrentProcessExplicitAppUserModelID` antes de criar janelas.
O identificador técnico é `com.luis.controlcode.ADEAGS`: Windows não permite espaços
no AUMID; o nome visível continua **ADE AGS**. O identifier Tauri
`com.luis.controlcode` permanece intacto para preservar dados e atualizações.

Na inicialização, uma STA COM própria cria ou atualiza `ADE AGS.lnk` na pasta
Programs do usuário, obtida por `SHGetKnownFolderPath(FOLDERID_Programs)`.
O destino é o executável atual, o ícone é o bot incorporado em `icons/icon.ico`,
copiado para `%LOCALAPPDATA%/ADE AGS/notifications/bot.ico`, e a propriedade
`System.AppUserModel.ID` contém o mesmo AUMID. Arquivos iguais não são regravados;
arquivos ausentes, ícone antigo e atalhos com outro destino são reparados.
Não há PowerShell, instalação global ou requisito de administrador. Falhas são
registradas em stderr e não impedem abrir a aplicação.

O registro `HKCU/Software/Classes/AppUserModelId/com.luis.controlcode.ADEAGS`
recebe `DisplayName=ADE AGS`, `IconUri` apontando para o bot e fundo transparente.
Isso fornece a identidade visual mesmo antes de o Shell atualizar seu cache do
Menu Iniciar. Somente essas três propriedades da identidade própria são escritas.

O plugin Tauri seleciona outra identidade em `target/debug` e `target/release` e
não oferece callback de clique desktop. Por isso, no Windows o backend usa
`tauri-winrt-notification` 0.8.1 diretamente (a versão já resolvida no lockfile).
Linux/macOS continuam pelo plugin. Cada resposta e `ags notify` guarda sua janela,
aba e fio no callback próprio: clicar em um aviso antigo abre aquele destino,
restaura a janela minimizada e dá foco. O evento `cc-chat-notification-clicked`
é enviado somente à janela dona; o listener abre o chat na resposta correspondente.
No Windows não se usa a aproximação anterior de abrir o último aviso ao recuperar foco.
Eventos sem agente (missão, aprovação, conta, rotina) focam a janela principal.
Ativação pressupõe que a app e a aba ainda estejam abertas; não há ativador COM
para iniciar uma instância fechada. Dev e instalado compartilham o registro por
usuário: a última instância iniciada atualiza o destino do atalho.

## Verificação automatizada

`cargo test --lib notifier::` cobre identidade estável em dev/instalado,
nome e montagem do atalho, caminhos Unicode/com espaços e decisão idempotente
de escrita, além das regras de notificação existentes. `tsc --noEmit` e Vitest
validam o listener e as regressões do frontend. Os testes puros não escrevem
no Menu Iniciar nem disparam toasts.

## Verificação manual necessária

1. Abrir `tauri dev --no-watch` como usuário comum a partir do PowerShell;
   colocar a app em segundo plano e enviar `ags say` e `ags notify`.
   Conferir **ADE AGS** e o ícone do bot no cabeçalho do toast.
2. Repetir no build instalado e com uma janela secundária minimizada.
   Clicar em duas notificações em ordem inversa: cada clique deve restaurar
   a janela dona e abrir a aba/fio do aviso clicado.
3. Voltar manualmente à janela após receber um aviso: isso não deve abrir o
   chat automaticamente no Windows. Verificar configuração de notificações
   desativada e app já focada: nenhum toast deve aparecer.
4. Conferir destino, ícone e `System.AppUserModel.ID` do atalho. Reiniciar
   sem alterações; apagar o atalho/ícone e reiniciar; alternar dev/instalado.
   Conferir reparo e nenhuma solicitação de privilégio administrativo.
5. Verificar após reiniciar o Explorer/Windows, pois o Shell pode manter em
   cache o nome e ícone de identidades antigas. Testar Windows 10 e 11 com
   notificações permitidas (Focus Assist pode ocultá-las).
