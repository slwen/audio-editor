import { SoundTouchNode } from '@soundtouchjs/audio-worklet'

const registeredContexts = new WeakSet<BaseAudioContext>()

export async function ensureSoundTouchWorklet(ctx: BaseAudioContext): Promise<void> {
  if (registeredContexts.has(ctx)) return
  const url = new URL('/soundtouch-processor.js', window.location.origin).href
  await SoundTouchNode.register(ctx, url)
  registeredContexts.add(ctx)
}
