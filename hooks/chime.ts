/** One soft "ting", made on the spot: a decaying sine with a touch of octave, as a 22 kHz mono WAV. */
export function chimeWav(freq: number, seconds = 1.1, decay = 4): string {
  const rate = 22050
  const n = Math.floor(rate * seconds)
  const pcm = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const v = 0.6 * Math.exp(-decay * t) * (Math.sin(2 * Math.PI * freq * t) + 0.2 * Math.sin(4 * Math.PI * freq * t)) / 1.2
    pcm[i] = Math.round(Math.max(-1, Math.min(1, v)) * 32767)
  }
  const bytes = new Uint8Array(44 + n * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)))
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + n * 2, true)
  ascii(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, n * 2, true)
  bytes.set(new Uint8Array(pcm.buffer), 44)
  // the environment has Uint8Array.prototype.toBase64; the es2023 lib does not declare it yet
  return (bytes as unknown as { toBase64(): string }).toBase64()
}

/** Higher for "on" and "your turn", lower for "talk mode ended". */
export const CHIME_ON = chimeWav(880)
export const CHIME_OFF = chimeWav(523.25)
