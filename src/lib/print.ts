import { inline, parseLine } from './script'
import type { Direction } from './doc'

// 1ページ = 40字 × 36行（縦書きは A4 横、横書きは A4 縦）
const COLS = 40
const ROWS = 36
const FONT_MM = 3.7 // 約10.5pt
const PITCH_MM = 6.5

// 行頭に来てはいけない文字（1字までぶら下げる）
const NO_HEAD = '、。，．・：；？！?!ー－）〕］｝〉》」』】〙〗ゝゞヽヾぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ…‥'

const charW = (ch: string) => (/[\x20-\x7e｡-ﾟ]/.test(ch) ? 0.5 : 1)

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

type Atom = { text: string; html: string; w: number }

function atoms(text: string): Atom[] {
  const out: Atom[] = []
  for (const seg of inline(text)) {
    const wrapTag = (h: string) => {
      if (seg.b) h = `<b>${h}</b>`
      if (seg.i) h = `<i>${h}</i>`
      if (seg.s) h = `<s>${h}</s>`
      return h
    }
    if (seg.ruby) {
      const w = Array.from(seg.text).reduce((a, c) => a + charW(c), 0)
      out.push({ text: seg.text, w, html: wrapTag(`<ruby>${esc(seg.text)}<rt>${esc(seg.ruby)}</rt></ruby>`) })
    } else {
      for (const ch of Array.from(seg.text)) out.push({ text: ch, w: charW(ch), html: wrapTag(esc(ch)) })
    }
  }
  return out
}

function wrap(text: string, firstIndent: number, restIndent: number): string[] {
  const out: string[] = []
  let indent = firstIndent
  let line = ''
  let w = 0
  const flush = () => {
    out.push('　'.repeat(indent) + line)
    line = ''
    w = 0
    indent = restIndent
  }
  for (const a of atoms(text)) {
    if (w + a.w > COLS - indent && line) {
      if (NO_HEAD.includes(a.text) && w + a.w <= COLS - indent + 1) {
        line += a.html
        flush()
        continue
      }
      flush()
    }
    line += a.html
    w += a.w
  }
  if (line || !out.length) flush()
  return out
}

type Row = { html: string; scene?: boolean; brk?: boolean }

function layout(body: string): Row[] {
  const rows: Row[] = []
  for (const raw of body.split('\n')) {
    const l = parseLine(raw)
    switch (l.kind) {
      case 'blank':
        rows.push({ html: '' })
        break
      case 'break':
        rows.push({ html: '', brk: true })
        break
      case 'scene':
        if (rows.length && rows[rows.length - 1].html !== '') rows.push({ html: '' })
        for (const t of wrap('○' + l.text, 0, 1)) rows.push({ html: t, scene: true })
        break
      case 'dialogue': {
        const hang = Math.min(Array.from(l.speaker).length + 1, 8)
        for (const t of wrap(raw.trim(), 0, hang)) rows.push({ html: t })
        break
      }
      case 'action':
        for (const t of wrap(l.text, 3, 3)) rows.push({ html: t })
        break
    }
  }
  return rows
}

function paginate(rows: Row[]): Row[][] {
  const pages: Row[][] = []
  let page: Row[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (r.brk) {
      if (page.length) pages.push(page)
      page = []
      continue
    }
    if (!page.length && r.html === '') continue // ページ頭の空行は捨てる
    // 見出しがページ末尾に取り残されないように
    const next = rows[i + 1]
    if (r.scene && page.length === ROWS - 1 && next && !next.scene) {
      pages.push(page)
      page = []
    }
    page.push(r)
    if (page.length === ROWS) {
      pages.push(page)
      page = []
    }
  }
  if (page.length || !pages.length) pages.push(page)
  return pages
}

/** #print-root に印刷用ページを組んで、印刷ダイアログ（PDFとして保存）を開く */
export function printScript(body: string, dir: Direction) {
  const root = document.getElementById('print-root')!
  const pages = paginate(layout(body))
  const vertical = dir === 'vertical'
  const pageW = vertical ? 297 : 210
  const pageH = vertical ? 210 : 297
  const boxLong = COLS * FONT_MM
  const boxShort = ROWS * PITCH_MM

  root.innerHTML = `
<style>
@page { size: A4 ${vertical ? 'landscape' : 'portrait'}; margin: 0; }
#print-root .page {
  width: ${pageW}mm; height: ${pageH}mm; position: relative; overflow: hidden;
  break-after: page; display: flex; align-items: center; justify-content: center;
}
#print-root .page:last-child { break-after: auto; }
#print-root .box {
  writing-mode: ${vertical ? 'vertical-rl' : 'horizontal-tb'};
  width: ${vertical ? boxShort : boxLong}mm; height: ${vertical ? boxLong : boxShort}mm;
  font-size: ${FONT_MM}mm; line-height: ${PITCH_MM}mm;
}
#print-root .r { white-space: pre; ${vertical ? `width: ${PITCH_MM}mm` : `height: ${PITCH_MM}mm`}; }
#print-root .r.s { font-weight: bold; }
#print-root rt { font-size: 50%; }
#print-root .no { position: absolute; bottom: 10mm; left: 0; right: 0; text-align: center; font-size: 3mm; }
</style>
${pages
  .map(
    (p, i) =>
      `<div class="page"><div class="box">${p
        .map((r) => `<div class="r${r.scene ? ' s' : ''}">${r.html}</div>`)
        .join('')}</div><div class="no">${i + 1}</div></div>`,
  )
  .join('')}`

  const done = () => {
    root.innerHTML = ''
    window.removeEventListener('afterprint', done)
  }
  window.addEventListener('afterprint', done)
  requestAnimationFrame(() => window.print())
}
