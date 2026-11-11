import { parseLine } from './script'

// エディターの下に敷く色分け用の HTML。
// 上の textarea と文字位置がずれないよう、文字幅を変えない装飾（色・輪郭・線）だけを使う。

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const MARK = /\*\*|~~|\*|[|｜](?=[^|｜《》\n]+?《)|《[^》\n]*》/g

function inl(s: string): string {
  let out = ''
  let last = 0
  let b = false
  let i = false
  let st = false
  const text = (t: string) => {
    if (!t) return ''
    const cls = [b && 'b', i && 'i', st && 's'].filter(Boolean).join(' ')
    return cls ? `<span class="${cls}">${esc(t)}</span>` : esc(t)
  }
  for (const m of s.matchAll(MARK)) {
    out += text(s.slice(last, m.index))
    // ルビの《よみ》は内容なので常に見せる（class r）。それ以外の記号は編集中の行だけ見せる（class m）
    out += `<span class="${m[0].startsWith('《') ? 'r' : 'm'}">${esc(m[0])}</span>`
    if (m[0] === '**') b = !b
    else if (m[0] === '*') i = !i
    else if (m[0] === '~~') st = !st
    last = m.index! + m[0].length
  }
  return out + text(s.slice(last))
}

export function highlight(body: string): string {
  return (
    body
      .split('\n')
      .map((line, i) => `<span data-l="${i}">${render(line)}</span>`)
      .join('\n') + '\n '
  )
}

function render(line: string): string {
  const l = parseLine(line)
  if (l.kind === 'scene') {
    const m = line.match(/^(\s*#+\s*)(.*)$/)!
    return `<span class="m">${esc(m[1])}</span><span class="h h${Math.min(l.level, 3)}">${inl(m[2])}</span>`
  }
  if (l.kind === 'break') return `<span class="r">${esc(line)}</span>`
  if (l.kind === 'dialogue') {
    const i = line.indexOf(l.speaker)
    return esc(line.slice(0, i)) + `<span class="n">${esc(l.speaker)}</span>` + inl(line.slice(i + l.speaker.length))
  }
  return inl(line)
}
