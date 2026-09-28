/** Pick a readable timeline interval from 1, 2, 5 × powers of ten. */
export function rulerStepSeconds(pixelsPerSecond: number, minLabelSpacingPx: number): number {
  const minimumSeconds = minLabelSpacingPx / pixelsPerSecond
  const power = 10 ** Math.floor(Math.log10(Math.max(1, minimumSeconds)))
  for (const multiple of [1, 2, 5, 10]) {
    const step = multiple * power
    if (step >= minimumSeconds) return step
  }
  return 10 * power
}
