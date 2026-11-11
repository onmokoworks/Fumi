import type { Voice } from './doc'
import { seedOf } from './script'

// 声のライブラリ
//   preset:xxx  … 内蔵のプリセット（説明文だけで声を作る。参照音声いらず）
//   file:xxx    … Irodori-TTS-Server の voices フォルダにある参照音声
// 何も選ばれていない話者は、名前から自動でプリセットを割り当てる。

export type Preset = { id: string; label: string; caption: string; seed: number }

export const PRESETS: Preset[] = [
  { id: 'f_bright', label: '明るい若い女性', caption: '明るく元気な若い女性の声。はきはきとした話し方。', seed: 1201 },
  { id: 'f_calm', label: '落ち着いた女性', caption: '落ち着いた大人の女性の声。穏やかで柔らかい話し方。', seed: 1202 },
  { id: 'f_girl', label: '少女', caption: '可愛らしい少女の声。高めで無邪気な話し方。', seed: 1203 },
  { id: 'm_young', label: '若い男性', caption: '爽やかな若い男性の声。自然で明るい話し方。', seed: 1301 },
  { id: 'm_low', label: '低い声の男性', caption: '低く落ち着いた大人の男性の声。ゆっくりとした話し方。', seed: 1302 },
  { id: 'm_boy', label: '少年', caption: '元気な少年の声。高めで快活な話し方。', seed: 1303 },
  { id: 'old_f', label: '年配の女性', caption: '優しい年配の女性の声。ゆっくりと穏やかな話し方。', seed: 1401 },
  { id: 'old_m', label: '年配の男性', caption: '少ししわがれた年配の男性の声。穏やかでゆっくりした話し方。', seed: 1402 },
  { id: 'narrator', label: 'ナレーター', caption: '落ち着いたナレーターの声。明瞭で聞き取りやすく、淡々とした語り口。', seed: 1501 },
]

const presetById = (id: string) => PRESETS.find((p) => p.id === id)

const FEMALE = ['f_bright', 'f_calm', 'f_girl', 'old_f']
const MALE = ['m_young', 'm_low', 'm_boy', 'old_m']
const ANY = ['f_bright', 'm_young', 'f_calm', 'm_low', 'f_girl', 'm_boy']

/** 名前からそれらしいプリセットの候補順を返す */
function guess(name: string): string[] {
  if (name === '地の文' || /ナレ|語り/.test(name)) return ['narrator', 'f_calm', 'm_low']
  if (/婆|祖母|おばあ/.test(name)) return ['old_f', ...FEMALE]
  if (/爺|祖父|おじい|老人|翁/.test(name)) return ['old_m', ...MALE]
  if (/少女|娘|妹|ちゃん$/.test(name)) return ['f_girl', ...FEMALE]
  if (/少年|弟|坊|くん$|君$/.test(name)) return ['m_boy', ...MALE]
  if (/母|姉|女|妻|嬢|姫|[子美香奈恵花菜乃江代絵里華咲]$/.test(name)) return FEMALE
  if (/父|兄|男|夫|[郎雄介助彦吉太司斗翔也樹蔵平治]$/.test(name)) return MALE
  // わからない名前は名前のハッシュで散らす
  const h = seedOf(name)
  return ANY.map((_, i) => ANY[(h + i) % ANY.length])
}

/** 話者の並び順に、なるべく声がかぶらないよう自動で割り当てる */
export function autoAssign(speakers: string[]): Map<string, string> {
  const used = new Set<string>()
  const out = new Map<string, string>()
  for (const sp of speakers) {
    const cands = guess(sp)
    const pick = cands.find((c) => !used.has(c)) ?? cands[0]
    used.add(pick)
    out.set(sp, pick)
  }
  return out
}

export type Resolved = {
  label: string
  caption?: string
  reference?: string
  voiceId?: string
  speed?: number
  seed: number
}

/** 話者の声を決める */
export function resolveVoice(speaker: string, v: Voice | undefined, auto: Map<string, string>): Resolved {
  const speed = v?.speed && Math.abs(v.speed - 1) > 1e-3 ? v.speed : undefined
  return { ...pick(speaker, v, auto), speed }
}

function pick(speaker: string, v: Voice | undefined, auto: Map<string, string>): Resolved {
  const note = v?.note?.trim()
  const withNote = (c?: string) => [c, note].filter(Boolean).join(' ') || undefined
  const use = v?.use
  if (use?.startsWith('file:')) {
    const id = use.slice(5)
    return { label: id, voiceId: id, caption: withNote(), seed: seedOf(speaker) }
  }
  if (use?.startsWith('preset:')) {
    const p = presetById(use.slice(7))
    if (p) return { label: p.label, caption: withNote(p.caption), seed: p.seed }
  }
  // 以前の形式（参照音声のパス・説明文を直接指定）
  if (!use && (v?.ref || v?.caption)) {
    return { label: '個別指定', reference: v.ref, caption: withNote(v.caption), seed: seedOf(speaker) }
  }
  const p = presetById(auto.get(speaker) ?? '') ?? presetById(guess(speaker)[0])!
  return { label: `自動：${p.label}`, caption: withNote(p.caption), seed: p.seed }
}
