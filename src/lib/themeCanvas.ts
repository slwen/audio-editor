/** Read a CSS custom property as a color string (hex, rgb(), etc.). */
export function readCssColor(varName: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  return v || fallback
}

export function parseHexRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return { r: 95, g: 201, b: 231 }
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

/** `rgba()` string for a 6-digit hex color at the given alpha. */
export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = parseHexRgb(hex)
  return `rgba(${r},${g},${b},${alpha})`
}
