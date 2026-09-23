export const FEEL_LABELS = { exploration: 'Exploration', tension: 'Tension', combat: 'Combat', intensity: 'High intensity' }
export function musicTime(sec: number): string {
  const ticks = Math.max(0, Math.round(sec * 10))
  return `${Math.floor(ticks / 600)}:${((ticks % 600) / 10).toFixed(1).padStart(4, '0')}`
}
