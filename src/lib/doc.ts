import YAML from 'yaml'

export type Direction = 'vertical' | 'horizontal'
/** use: 'preset:ID' | 'file:ID'（未指定なら自動）。note: 演技の指示。ref/caption は以前の形式 */
export type Voice = { use?: string; note?: string; speed?: number; ref?: string; caption?: string }
export type Meta = { direction?: Direction; voices?: Record<string, Voice> }

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function parseDoc(src: string): { meta: Meta; body: string } {
  const m = src.match(FM)
  if (!m) return { meta: {}, body: src.replace(/\r\n/g, '\n') }
  let meta: Meta = {}
  try {
    meta = (YAML.parse(m[1]) as Meta) ?? {}
  } catch {
    meta = {}
  }
  return { meta, body: src.slice(m[0].length).replace(/\r\n/g, '\n') }
}

export function serializeDoc(meta: Meta, body: string): string {
  const clean: Meta = {}
  if (meta.direction) clean.direction = meta.direction
  const voices = Object.fromEntries(
    Object.entries(meta.voices ?? {})
      .map(([k, v]) => [k, prune(v)] as const)
      .filter(([, v]) => Object.keys(v).length > 0),
  )
  if (Object.keys(voices).length) clean.voices = voices
  if (!Object.keys(clean).length) return body
  return `---\n${YAML.stringify(clean).trimEnd()}\n---\n${body}`
}

function prune(v: Voice): Voice {
  const o: Voice = {}
  if (v.use?.trim()) o.use = v.use.trim()
  if (v.note?.trim()) o.note = v.note.trim()
  if (v.speed && Math.abs(v.speed - 1) > 1e-3) o.speed = Math.round(v.speed * 100) / 100
  if (v.ref?.trim()) o.ref = v.ref.trim()
  if (v.caption?.trim()) o.caption = v.caption.trim()
  return o
}

export function todayPrefix(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
