// Ponte mínima para o AVCMediaStreamNegotiator (AVConference, Objective-C), carregado por dlopen: só o negociador
// local, que monta a oferta e lê a resposta. O AVCVideoStream/MediaStreamSession exigem um entitlement restrito e
// ficam de fora.
#import <Foundation/Foundation.h>

/// Cria o negociador no `modo` (5 = CoreDeviceScreenSharing). `nil` se o AVConference não carregar.
id _Nullable AdeNegociadorCriar(NSInteger modo, NSDictionary * _Nonnull opcoes, NSError * _Nullable * _Nullable erro);
NSData * _Nullable AdeNegociadorOferta(id _Nonnull negociador);
BOOL AdeNegociadorDefinirResposta(id _Nonnull negociador, NSData * _Nonnull resposta, NSError * _Nullable * _Nullable erro);
/// O valor de uma constante `NSString *` exportada pelo AVConference (`nil` se não existir).
NSString * _Nullable AdeNegociadorConstante(const char * _Nonnull nome);
