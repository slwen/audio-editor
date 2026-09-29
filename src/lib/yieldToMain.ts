/** Let input and rendering run between bounded CPU batches. */
export async function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield: () => Promise<void> } }).scheduler
  if (scheduler?.yield) await scheduler.yield()
  else await new Promise<void>(resolve => setTimeout(resolve, 0))
}
