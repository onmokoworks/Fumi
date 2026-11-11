// 尺（再生時間）の計算

/** WAV の長さ（秒） */
export function wavSeconds(buf: ArrayBuffer): number {
  const v = new DataView(buf)
  let i = 12
  let byteRate = 0
  while (i + 8 <= v.byteLength) {
    const id = String.fromCharCode(v.getUint8(i), v.getUint8(i + 1), v.getUint8(i + 2), v.getUint8(i + 3))
    const size = v.getUint32(i + 4, true)
    if (id === 'fmt ') byteRate = v.getUint32(i + 16, true)
    if (id === 'data') return byteRate ? Math.min(size, v.byteLength - i - 8) / byteRate : 0
    i += 8 + size + (size & 1)
  }
  return 0
}

/** まだ生成していない行の長さの目安（実測：11字≈2.9秒、22字≈4.3秒） */
export function estimateSeconds(text: string, speed = 1): number {
  const chars = Array.from(text.replace(/\s/g, '')).length
  return (0.6 + chars / 5.5) / (speed || 1)
}

/** 書き出しでセリフの間に入れる無音（Rust 側の gap_ms と同じ） */
export const GAP_SECONDS = 0.4

export function fmtSeconds(sec: number): string {
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}秒`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}分${String(s).padStart(2, '0')}秒`
}
