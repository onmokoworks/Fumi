import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

export const DEFAULT_FONT = 'Yu Mincho'

const SAMPLE = '永遠の文字 あいうえお アイウエオ Aa 123'
const PAGE = 60

// 候補の分類（名前から推測）
const CATS: { id: string; label: string; re?: RegExp }[] = [
  { id: 'fav', label: '★' },
  { id: 'mincho', label: '明朝', re: /Mincho|明朝|Serif JP|Shippori|Zen Old|Kaisei|Hina|Klee|Noto Serif/i },
  { id: 'gothic', label: 'ゴシック', re: /Yu Gothic|BIZ UDP?Gothic|Meiryo|メイリオ|Sans JP|ゴシック|ｺﾞｼｯｸ|AXIS|Kosugi|M PLUS|MS P?Gothic|Gothic(?! (Demi|Medium|Book))/i },
  { id: 'maru', label: '丸ゴシック', re: /丸|Maru|Round/i },
  { id: 'kyokasho', label: '教科書体・楷書', re: /Kyokasho|教科書|楷書|Kaisho|ｷｮｳｶｼｮ/i },
  { id: 'fude', label: '筆・手書き', re: /行書|Gyosho|毛筆|筆|手書|Pop|ﾎﾟｯﾌﾟ|ポップ|Klee|Yusei|Zen Kurenaido/i },
  { id: 'all', label: 'すべて' },
]

// 日本語で探しても英語名の書体が見つかるように
const ALIASES: [RegExp, string][] = [
  [/明朝/, 'mincho'],
  [/ゴシック/, 'gothic'],
  [/游/, 'yu '],
  [/メイリオ/, 'meiryo'],
  [/教科書/, 'kyokasho'],
  [/丸/, 'maru|round'],
  [/楷書/, 'kaisho'],
  [/行書/, 'gyosho'],
]

function matcher(query: string): (f: string) => boolean {
  const q = query.trim().toLowerCase()
  if (!q) return () => true
  const alts = [q, ...ALIASES.filter(([re]) => re.test(q)).flatMap(([, en]) => en.split('|'))]
  return (f) => {
    const n = f.toLowerCase()
    return alts.some((a) => n.includes(a))
  }
}

export function FontPicker(props: {
  current: string
  favorites: string[]
  onPick: (font: string) => void
  onFavorites: (favs: string[]) => void
  onClose: () => void
}) {
  const [fonts, setFonts] = useState<string[] | null>(null)
  const [q, setQ] = useState('')
  const query = useDeferredValue(q)
  const [cat, setCat] = useState('fav')
  const [limit, setLimit] = useState(PAGE)
  const [sel, setSel] = useState(-1)
  const original = useRef(props.current)
  const input = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    invoke<string[]>('list_fonts')
      .then(setFonts)
      .catch(() => setFonts([DEFAULT_FONT]))
    input.current?.focus()
  }, [])

  // 検索を始めたら「すべて」から探す
  useEffect(() => {
    if (q.trim()) setCat('all')
  }, [q])
  useEffect(() => {
    setLimit(PAGE)
    setSel(-1)
  }, [query, cat])

  const counts = useMemo(() => {
    const all = fonts ?? []
    return Object.fromEntries(
      CATS.map((c) => [c.id, c.id === 'fav' ? props.favorites.length : c.re ? all.filter((f) => c.re!.test(f)).length : all.length]),
    )
  }, [fonts, props.favorites])

  const list = useMemo(() => {
    const all = fonts ?? []
    const c = CATS.find((x) => x.id === cat)!
    const base = cat === 'fav' ? props.favorites : c.re ? all.filter((f) => c.re!.test(f)) : all
    const m = matcher(query)
    // お気に入りを先頭に
    const hits = base.filter(m)
    return [...hits.filter((f) => props.favorites.includes(f)), ...hits.filter((f) => !props.favorites.includes(f))]
  }, [fonts, cat, query, props.favorites])

  const shown = list.slice(0, limit)

  const toggleFav = (f: string) =>
    props.onFavorites(props.favorites.includes(f) ? props.favorites.filter((x) => x !== f) : [...props.favorites, f])

  const move = (d: number) => {
    const n = Math.max(0, Math.min(shown.length - 1, sel + d))
    setSel(n)
    if (shown[n]) props.onPick(shown[n]) // その場で試す
    listRef.current?.children[n]?.scrollIntoView({ block: 'nearest' })
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (shown[sel]) props.onPick(shown[sel])
      props.onClose()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      props.onPick(original.current) // 試していた書体を元に戻す
      props.onClose()
    }
  }

  return (
    <div className="overlay">
      <div className="panel fonts">
        <input
          ref={input}
          className="search"
          placeholder="書体を検索（明朝、ゴシック、游、BIZ など）　↑↓で試す・Enterで決定・Escで戻す"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="chips">
          {CATS.map((c) => (
            <button key={c.id} className={cat === c.id ? 'on' : ''} onClick={() => setCat(c.id)}>
              {c.label}
              <span className="muted"> {counts[c.id] ?? 0}</span>
            </button>
          ))}
        </div>
        {fonts === null ? (
          <p className="muted">書体を読み込んでいます…</p>
        ) : (
          <>
            <ul className="fontlist" ref={listRef}>
              {shown.map((f, i) => (
                <li
                  key={f}
                  className={`${f === props.current ? 'cur' : ''} ${i === sel ? 'sel' : ''}`}
                  onClick={() => {
                    setSel(i)
                    props.onPick(f)
                  }}
                  onDoubleClick={() => {
                    props.onPick(f)
                    props.onClose()
                  }}
                >
                  <button
                    className={`star ${props.favorites.includes(f) ? 'on' : ''}`}
                    title={props.favorites.includes(f) ? 'お気に入りから外す' : 'お気に入りにする'}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleFav(f)
                    }}
                  >
                    {props.favorites.includes(f) ? '★' : '☆'}
                  </button>
                  <span className="fname">
                    {f}
                    {f === DEFAULT_FONT && <span className="muted">（標準）</span>}
                  </span>
                  <span className="fsample" style={{ fontFamily: `"${f}", var(--font-fallback)` }}>
                    {SAMPLE}
                  </span>
                </li>
              ))}
              {!shown.length && <li className="muted">見つかりません</li>}
            </ul>
            {list.length > shown.length && (
              <button className="link more" onClick={() => setLimit((l) => l + PAGE)}>
                もっと見る（あと {list.length - shown.length} 件）
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
