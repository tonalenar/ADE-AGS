#import "Negociador.h"
#import <dlfcn.h>
#import <objc/message.h>

static void *avconference(void) {
  static void *handle;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    handle = dlopen("/System/Library/PrivateFrameworks/AVConference.framework/AVConference", RTLD_NOW);
  });
  return handle;
}

id AdeNegociadorCriar(NSInteger modo, NSDictionary *opcoes, NSError **erro) {
  if (!avconference()) return nil;
  Class classe = NSClassFromString(@"AVCMediaStreamNegotiator");
  SEL init = NSSelectorFromString(@"initWithMode:options:error:");
  if (!classe || ![classe instancesRespondToSelector:init]) return nil;
  id objeto = ((id(*)(id, SEL))objc_msgSend)(classe, @selector(alloc));
  return ((id(*)(id, SEL, NSInteger, id, NSError **))objc_msgSend)(objeto, init, modo, opcoes, erro);
}

NSData *AdeNegociadorOferta(id negociador) {
  SEL offer = NSSelectorFromString(@"offer");
  if (![negociador respondsToSelector:offer]) return nil;
  id oferta = ((id(*)(id, SEL))objc_msgSend)(negociador, offer);
  return [oferta isKindOfClass:[NSData class]] ? oferta : nil;
}

BOOL AdeNegociadorDefinirResposta(id negociador, NSData *resposta, NSError **erro) {
  SEL setAnswer = NSSelectorFromString(@"setAnswer:withError:");
  if (![negociador respondsToSelector:setAnswer]) return NO;
  return ((BOOL(*)(id, SEL, id, NSError **))objc_msgSend)(negociador, setAnswer, resposta, erro);
}

NSString *AdeNegociadorConstante(const char *nome) {
  void *h = avconference();
  if (!h) return nil;
  void *p = dlsym(h, nome);
  if (!p) return nil;
  id valor = *(__unsafe_unretained id *)p;
  return [valor isKindOfClass:[NSString class]] ? valor : nil;
}
