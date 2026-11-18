/** Uma vez montado, o iframe da prancheta não desmonta ao sair da tela. */
export function keepFrameMounted(hasBeenLive: boolean, visible: boolean): boolean {
  return hasBeenLive || visible;
}
