#import "Negociador.h"
#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>

static void *avconference(void) {
  static void *handle;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    handle = dlopen("/System/Library/PrivateFrameworks/AVConference.framework/AVConference", RTLD_NOW);
  });
  return handle;
}

// Sem VRAE:0, o encoder pode adaptar a resolução em vez de descartar quadros sob carga.
static NSDictionary *(*featureListOriginal)(id, SEL);

static NSDictionary *featureListAdaptavel(id settings, SEL seletor) {
  NSDictionary *original = featureListOriginal(settings, seletor);
  NSMutableDictionary *ajustada = [original mutableCopy];
  for (id chave in original) {
    NSString *valor = original[chave];
    if (![valor isKindOfClass:[NSString class]]) continue;
    NSMutableArray *tokens = [[valor componentsSeparatedByString:@";"] mutableCopy];
    [tokens removeObject:@"VRAE:0"];
    ajustada[chave] = [tokens componentsJoinedByString:@";"];
  }
  return ajustada;
}

static BOOL habilitarAdaptacao(void) {
  static BOOL habilitada;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    Class settings = NSClassFromString(@"AVCMediaStreamNegotiatorSettingsCoreDeviceScreenSharing");
    SEL seletor = NSSelectorFromString(@"featureListString");
    Method metodo = class_getInstanceMethod(settings, seletor);
    if (!metodo) return;
    featureListOriginal = (NSDictionary *(*)(id, SEL))method_getImplementation(metodo);
    class_replaceMethod(settings, seletor, (IMP)featureListAdaptavel, method_getTypeEncoding(metodo));
    habilitada = YES;
  });
  return habilitada;
}

id AdeNegociadorCriar(NSInteger modo, NSDictionary *opcoes, NSError **erro) {
  if (!avconference() || !habilitarAdaptacao()) return nil;
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
