// 台本の書式
//   # 見出し        → シーン（## ### も同じ）
//   名前「セリフ」   → セリフ
//   ---             → 改ページ（PDF）
//   それ以外         → ト書き
// 行の中で使える記法
//   **太字**  *斜体*  ~~取り消し~~  |漢字《かんじ》 / 漢字《かんじ》（ルビ。読み上げはルビで読む）

export type Line =
  | { kind: 'scene'; text: string; level: number }
  | { kind: 'dialogue'; speaker: string; text: string }
  | { kind: 'action'; text: string }
  | { kind: 'break' }
  | { kind: 'blank' }

const DIALOGUE = /^\s*([^\s「『#　*~|]{1,16})[ 　]*[「『](.*?)[」』]?\s*$/

export function parseLine(raw: string): Line {
  if (!raw.trim()) return { kind: 'blank' }
  if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) return { kind: 'break' }
  const h = raw.match(/^\s*(#{1,6})\s*(.*)$/)
  if (h) return { kind: 'scene', text: h[2], level: h[1].length }
  const m = raw.match(DIALOGUE)
  if (m && m[2].trim()) return { kind: 'dialogue', speaker: m[1], text: m[2] }
  return { kind: 'action', text: raw.trim() }
}

export function speakersOf(body: string): string[] {
  const seen = new Set<string>()
  for (const raw of body.split('\n')) {
    const l = parseLine(raw)
    if (l.kind === 'dialogue') seen.add(l.speaker)
  }
  return [...seen]
}

/** 話者名から決まる固定シード（参照音声なしでも毎回同じ声にするため） */
export function seedOf(name: string): number {
  let h = 2166136261
  for (const c of name) {
    h ^= c.codePointAt(0)!
    h = Math.imul(h, 16777619) >>> 0
  }
  return h % 2147483647
}

// ---------- 行内の記法 ----------

const KANJI = '[\\u3005\\u3006\\u3400-\\u9fff\\uf900-\\ufaff]'
export const RUBY = new RegExp(`[|｜]([^|｜《》\\n]+?)《([^》\\n]+)》|(${KANJI}+)《([^》\\n]+)》`, 'g')

export type Seg = { text: string; b?: boolean; i?: boolean; s?: boolean; ruby?: string }

/** 行内の記法を分解する（PDF用） */
export function inline(text: string): Seg[] {
  const out: Seg[] = []
  let b = false
  let i = false
  let s = false
  const re = new RegExp(`\\*\\*|~~|\\*|${RUBY.source}`, 'g')
  let last = 0
  let m: RegExpExecArray | null
  const push = (t: string) => t && out.push({ text: t, b, i, s })
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index))
    last = re.lastIndex
    if (m[0] === '**') b = !b
    else if (m[0] === '*') i = !i
    else if (m[0] === '~~') s = !s
    else out.push({ text: m[1] ?? m[3], ruby: m[2] ?? m[4], b, i, s })
  }
  push(text.slice(last))
  return out
}

/** 読み上げ用のテキスト（記法を外し、ルビは読みに置き換える） */
export function speechText(text: string): string {
  return text
    .replace(new RegExp(RUBY.source, 'g'), (_, _b1, r1, _b2, r2) => r1 ?? r2)
    .replace(/\*\*|~~|\*/g, '')
}
