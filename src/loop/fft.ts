/** In-place radix-2 FFT. `re` and `im` must be the same power-of-two length. */
export function fftRadix2(re: Float32Array, im: Float32Array): void {
  const n = re.length
  if (n !== im.length || n === 0 || (n & (n - 1)) !== 0) {
    throw new Error('FFT length must be a shared power of two')
  }

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]!
      re[i] = re[j]!
      re[j] = tr
      const ti = im[i]!
      im[i] = im[j]!
      im[j] = ti
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI) / len
    const wlenRe = Math.cos(ang)
    const wlenIm = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let wRe = 1
      let wIm = 0
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j]!
        const uIm = im[i + j]!
        const vr = re[i + j + half]!
        const vi = im[i + j + half]!
        const vRe = vr * wRe - vi * wIm
        const vIm = vr * wIm + vi * wRe
        re[i + j] = uRe + vRe
        im[i + j] = uIm + vIm
        re[i + j + half] = uRe - vRe
        im[i + j + half] = uIm - vIm
        const nRe = wRe * wlenRe - wIm * wlenIm
        wIm = wRe * wlenIm + wIm * wlenRe
        wRe = nRe
      }
    }
  }
}
