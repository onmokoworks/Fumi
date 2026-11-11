import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { parseDoc, serializeDoc, todayPrefix, type Direction, type Meta } from './lib/doc'
import { parseLine, speakersOf, speechText } from './lib/script'
import { printScript } from './lib/print'
import { highlight } from './lib/highlight'
import { ensureServer, startServer } from './lib/server'
import { autoAssign, resolveVoice } from './lib/voices'
import { GAP_SECONDS, estimateSeconds, fmtSeconds, wavSeconds } from './lib/duration'
import { FileList } from './components/FileList'
import { Voices } from './components/Voices'
import { Help } from './components/Help'
import { Menu, type Settings, type Theme } from './components/Menu'

type Overlay = null | 'menu' | 'list' | 'voices' | 'export' | 'help'
export type TtsReq = {
  text: string
  reference?: string
  caption?: string
  voice_id?: string
  speed?: number
  seed: number
  label: string
}

const ls = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v)
    } catch {
      /* noop */
    }
  },
}

export const NARRATOR = '地の文'

function loadSettings(): Settings {
  return {
    theme: (ls.get('theme') as Theme) || 'system',
    size: Number(ls.get('size')) || 19,
    server: ls.get('server') || 'http://127.0.0.1:8088',
    serverDir: ls.get('serverDir') ?? '',
    autostart: ls.get('autostart') === '1',
    readAction: ls.get('readAction') !== '0',
    // 読み上げ機能。初めはオフ（以前から使っている環境＝サーバー設定がある場合はオン）
    tts: ls.get('tts') != null ? ls.get('tts') === '1' : ls.get('server') != null,
  }
}

/** 自分で保存・オープンしたファイル（絶対パス）か。そうでなければ Fumi フォルダ内の自動名 */
export const isFilePath = (name: string | null) => !!name && /^([A-Za-z]:[\\/]|\\\\)/.test(name)
export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p

/** 最近使ったファイル（絶対パス） */
export function recentFiles(): string[] {
  try {
    return JSON.parse(localStorage.getItem('recent') || '[]')
  } catch {
    return []
  }
}
function addRecent(path: string) {
  const list = [path, ...recentFiles().filter((p) => p.toLowerCase() !== path.toLowerCase())].slice(0, 30)
  try {
    localStorage.setItem('recent', JSON.stringify(list))
  } catch {
    /* noop */
  }
}

/** .txt は本文だけ。.md は設定を frontmatter に入れる */
const contentFor = (name: string, meta: Meta, body: string) =>
  name.toLowerCase().endsWith('.txt') ? body : serializeDoc(meta, body)

export function reqFor(speaker: string, text: string, voices: Meta['voices'], auto: Map<string, string>): TtsReq {
  const r = resolveVoice(speaker, voices?.[speaker], auto)
  return {
    text: speechText(text),
    reference: r.reference,
    caption: r.caption,
    voice_id: r.voiceId,
    speed: r.speed,
    seed: r.seed,
    label: speaker,
  }
}

/** 再生速度（生成し直さずに速く/遅く聞く）。声の高さは保つ */
export const RATES = [0.75, 1, 1.25, 1.5, 2]
let playbackRate = (() => {
  try {
    return Number(localStorage.getItem('rate')) || 1
  } catch {
    return 1
  }
})()
export const getRate = () => playbackRate
export function setRateGlobal(r: number) {
  playbackRate = r
  try {
    localStorage.setItem('rate', String(r))
  } catch {
    /* noop */
  }
}

export async function synth(server: string, req: TtsReq): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>('tts', { server, req })
}

export function playBuffer(buf: ArrayBuffer, onAudio?: (a: HTMLAudioElement) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
    const a = new Audio(url)
    a.preservesPitch = true
    a.playbackRate = playbackRate
    onAudio?.(a)
    const end = () => {
      URL.revokeObjectURL(url)
      resolve()
    }
    a.onended = end
    a.onpause = end
    a.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('再生できません'))
    }
    a.play().catch(reject)
  })
}

const fmtTime = (ms: number) => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

type Rewind = { list: number[]; idx: number; text: string | null }

export default function App() {
  const [name, setName] = useState<string | null>(null)
  const [body, setBody] = useState('')
  const [meta, setMeta] = useState<Meta>({})
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [status, setStatus] = useState('')
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [ready, setReady] = useState(false)
  const [rewind, setRewind] = useState<Rewind | null>(null)
  const [playing, setPlaying] = useState<number | null>(null)
  const [rate, setRate] = useState(getRate)
  const changeRate = (r: number) => {
    setRateGlobal(r)
    setRate(r)
    if (player.current?.audio) player.current.audio.playbackRate = r
  }

  const ta = useRef<HTMLTextAreaElement>(null)
  const mirror = useRef<HTMLDivElement>(null)
  const st = useRef({ name: null as string | null, body: '', meta: {} as Meta, dirty: false })
  st.current.name = name
  st.current.body = body
  st.current.meta = meta
  const player = useRef<{ cancel: boolean; audio?: HTMLAudioElement } | null>(null)
  const statusTimer = useRef<number | undefined>(undefined)

  const { theme, size, server, serverDir, tts } = settings
  const dir: Direction = meta.direction ?? ((ls.get('direction') as Direction) || 'vertical')

  const set = useCallback((p: Partial<Settings>) => {
    setSettings((s) => {
      const n = { ...s, ...p }
      ls.set('theme', n.theme)
      ls.set('size', String(n.size))
      ls.set('server', n.server)
      ls.set('serverDir', n.serverDir)
      ls.set('autostart', n.autostart ? '1' : '0')
      ls.set('readAction', n.readAction ? '1' : '0')
      ls.set('tts', n.tts ? '1' : '0')
      return n
    })
  }, [])

  const flash = useCallback((msg: string, ms = 2500) => {
    setStatus(msg)
    window.clearTimeout(statusTimer.current)
    if (ms > 0) statusTimer.current = window.setTimeout(() => setStatus(''), ms)
  }, [])

  // ---------- 保存 ----------

  const save = useCallback(async () => {
    const s = st.current
    if (!s.dirty) return
    s.dirty = false
    try {
      let n = s.name
      if (!n) {
        if (!s.body.trim()) return
        n = await invoke<string>('new_doc_name', { prefix: todayPrefix() })
        s.name = n
        setName(n)
      }
      const content = contentFor(n, s.meta, s.body)
      await invoke('write_doc', { name: n, content })
      await invoke('history_add', { name: n, content, force: false }).catch(() => {})
    } catch (e) {
      s.dirty = true
      flash(`保存できません: ${e}`, 6000)
    }
  }, [flash])

  useEffect(() => {
    if (!st.current.dirty) return
    const t = window.setTimeout(save, 800)
    return () => window.clearTimeout(t)
  }, [body, meta, save])

  useEffect(() => {
    const onClose = () => void save()
    window.addEventListener('beforeunload', onClose)
    return () => window.removeEventListener('beforeunload', onClose)
  }, [save])

  const edit = (b: string) => {
    st.current.dirty = true
    setBody(b)
  }
  const editMeta = (fn: (m: Meta) => Meta) => {
    st.current.dirty = true
    setMeta((m) => fn(m))
  }

  const focusEditor = () => requestAnimationFrame(() => ta.current?.focus())

  /** 名前を付けて保存。自動名の下書きなら、選んだ場所へ移す */
  const saveAs = async () => {
    const s = st.current
    const first = (s.body.split('\n').find((l) => l.trim()) ?? '')
      .replace(/^\s*#+\s*/, '')
      .replace(/[\\/:*?"<>|「」『』]/g, '')
      .trim()
      .slice(0, 30)
    const dirPath = isFilePath(s.name)
      ? s.name!.slice(0, s.name!.length - baseName(s.name!).length)
      : await invoke<string>('docs_folder').then((d) => d + '\\').catch(() => '')
    const path = await saveDialog({
      title: '名前を付けて保存',
      defaultPath: dirPath + (isFilePath(s.name) ? baseName(s.name!) : (first || 'fumi') + '.md'),
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'テキスト', extensions: ['txt'] },
      ],
    })
    if (!path) return
    try {
      const content = contentFor(path, s.meta, s.body)
      if (s.name && !isFilePath(s.name)) await invoke('move_doc', { from: s.name, to: path, content })
      else await invoke('write_doc', { name: path, content })
      await invoke('history_add', { name: path, content, force: false }).catch(() => {})
      s.dirty = false
      s.name = path
      setName(path)
      addRecent(path)
      flash(`保存しました: ${path}`, 4000)
    } catch (e) {
      flash(`保存できません: ${e}`, 6000)
    }
  }

  /** Ctrl+S：まだ自分で保存していなければ「名前を付けて保存」、保存済みならそのファイルへ */
  const saveNow = async () => {
    const n = st.current.name
    if (!isFilePath(n)) {
      if (!st.current.body.trim() && !n) return flash('まだ何も書かれていません', 1500)
      return saveAs()
    }
    st.current.dirty = true
    await save()
    flash(`保存しました: ${n}`, 2500)
  }

  const openFile = async () => {
    const p = await openDialog({
      title: 'ファイルを開く',
      filters: [{ name: 'テキスト', extensions: ['md', 'txt', 'markdown'] }],
    })
    if (typeof p === 'string') await openDoc(p).catch((e) => flash(String(e), 6000))
  }

  const openDoc = useCallback(
    async (n: string) => {
      stop()
      setRewind(null)
      await save()
      const src = await invoke<string>('read_doc', { name: n })
      if (isFilePath(n)) addRecent(n)
      const { meta, body } = parseDoc(src)
      st.current.dirty = false
      setName(n)
      setMeta(meta)
      setBody(body)
      setOverlay(null)
      requestAnimationFrame(() => {
        ta.current?.focus()
        ta.current?.setSelectionRange(0, 0)
      })
    },
    [save],
  )

  const newDoc = useCallback(async () => {
    stop()
    setRewind(null)
    await save()
    st.current.dirty = false
    setName(null)
    setMeta({})
    setBody('')
    setOverlay(null)
    focusEditor()
  }, [save])

  // 起動時：最後に触った文章を開く。設定によってはTTSサーバーも起動
  useEffect(() => {
    invoke<{ name: string }[]>('list_docs')
      .then((docs) => (docs.length ? openDoc(docs[0].name) : undefined))
      .catch((e) => flash(String(e), 6000))
      .finally(() => {
        setReady(true)
        ta.current?.focus()
      })
    const s = loadSettings()
    // サーバーのフォルダが未設定なら探す
    if (!s.serverDir) invoke<string | null>('find_server_dir').then((d) => d && set({ serverDir: d }))
    if (s.tts && s.autostart && s.serverDir) startServer(s.serverDir, s.server).catch((e) => flash(String(e), 6000))
  }, [])

  // ウィンドウのタイトルに今のファイルを出す
  useEffect(() => {
    const t = !name ? 'Fumi' : isFilePath(name) ? `${baseName(name)} — Fumi` : `${name}（下書き） — Fumi`
    getCurrentWindow()
      .setTitle(t)
      .catch(() => {})
  }, [name])

  // ---------- 見た目 ----------

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    getCurrentWindow()
      .setTheme(theme === 'system' ? null : theme)
      .catch(() => {})
  }, [theme])

  const toggleDirection = () => {
    const next: Direction = dir === 'vertical' ? 'horizontal' : 'vertical'
    ls.set('direction', next)
    if (st.current.name || st.current.body.trim()) editMeta((m) => ({ ...m, direction: next }))
    else setMeta((m) => ({ ...m, direction: next }))
    flash(next === 'vertical' ? '縦書き' : '横書き', 1200)
  }

  const cycleTheme = () => {
    const next: Theme = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark'
    set({ theme: next })
    flash(next === 'system' ? 'テーマ: システムに合わせる' : next === 'dark' ? 'テーマ: 黒' : 'テーマ: 白', 1200)
  }

  const zoom = (d: number) => {
    const n = d === 0 ? 19 : Math.round(Math.min(64, Math.max(12, size * (d > 0 ? 1.1 : 1 / 1.1))))
    set({ size: n })
    flash(`${n}px`, 900)
  }

  // ---------- 履歴（タイムライン） ----------

  const rewindRef = useRef<Rewind | null>(null)
  rewindRef.current = rewind
  const histCache = useRef(new Map<number, string>())

  const showSnapshot = async (r: Rewind, idx: number) => {
    const n = st.current.name
    if (!n) return
    idx = Math.max(0, Math.min(r.list.length - 1, idx))
    const ts = r.list[idx]
    let text = histCache.current.get(ts)
    if (text === undefined) {
      text = await invoke<string>('history_read', { name: n, ts })
      histCache.current.set(ts, text)
    }
    setRewind({ ...r, idx, text })
  }

  const startRewind = async () => {
    stop()
    setOverlay(null)
    await save()
    const n = st.current.name
    if (!n) return flash('まだ履歴がありません')
    const content = serializeDoc(st.current.meta, st.current.body)
    await invoke('history_add', { name: n, content, force: false }).catch(() => {})
    const list = await invoke<number[]>('history_list', { name: n })
    if (list.length < 2) return flash('まだ履歴がありません')
    histCache.current.clear()
    const r = { list, idx: list.length - 1, text: null }
    await showSnapshot(r, list.length - 2)
  }

  const stepRewind = (d: number) => {
    const r = rewindRef.current
    if (r) void showSnapshot(r, r.idx + d)
  }

  const restoreRewind = async () => {
    const r = rewindRef.current
    const n = st.current.name
    if (!r || r.text == null || !n) return
    await invoke('history_add', { name: n, content: serializeDoc(st.current.meta, st.current.body), force: true })
    const { meta, body } = parseDoc(r.text)
    st.current.dirty = true
    setMeta(meta)
    setBody(body)
    setRewind(null)
    flash(`${fmtTime(r.list[r.idx])} の版に戻しました`)
    focusEditor()
  }

  // ---------- スクロール（慣性）・ズーム・履歴ホイール ----------

  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const stepRef = useRef(stepRewind)
  stepRef.current = stepRewind
  const startRewindRef = useRef(startRewind)
  startRewindRef.current = startRewind
  const overlayRef = useRef<Overlay>(null)
  overlayRef.current = overlay

  useEffect(() => {
    const el = ta.current
    if (!el) return
    let v = 0
    let raf = 0
    let acc = 0
    const step = () => {
      if (Math.abs(v) < 0.15) {
        v = 0
        raf = 0
        return
      }
      if (dir === 'vertical') el.scrollLeft -= v
      else el.scrollTop += v
      v *= 0.92
      raf = requestAnimationFrame(step)
    }
    const onWheel = (e: WheelEvent) => {
      const dy = e.deltaY * (e.deltaMode === 1 ? 40 : 1)
      // 履歴: Ctrl+Shift+ホイール で開始、開いている間はホイールで前後
      if (rewindRef.current || (e.ctrlKey && e.shiftKey)) {
        e.preventDefault()
        if (!rewindRef.current) {
          void startRewindRef.current()
          acc = 0
          return
        }
        acc += dy
        while (Math.abs(acc) >= 50) {
          stepRef.current(acc > 0 ? 1 : -1)
          acc -= Math.sign(acc) * 50
        }
        return
      }
      if (e.ctrlKey) {
        e.preventDefault()
        zoomRef.current(e.deltaY < 0 ? 1 : -1)
        return
      }
      if (overlayRef.current) return
      e.preventDefault()
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? el.clientHeight : 1
      const d =
        Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : dir === 'vertical' ? -e.deltaX : e.deltaX
      v = Math.max(-260, Math.min(260, v + d * unit * 0.09))
      if (!raf) raf = requestAnimationFrame(step)
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      window.removeEventListener('wheel', onWheel)
      cancelAnimationFrame(raf)
    }
  }, [dir])

  const syncMirror = () => {
    const a = ta.current
    const b = mirror.current
    if (a && b) {
      b.scrollTop = a.scrollTop
      b.scrollLeft = a.scrollLeft
    }
  }

  // ---------- 読み上げ ----------

  function stop() {
    if (player.current) {
      player.current.cancel = true
      player.current.audio?.pause()
      player.current = null
      setPlaying(null)
      setStatus('')
    }
  }

  // 話者ごとの自動の声（地の文 → 出てくる順）
  const auto = useMemo(() => {
    const hasAct = settings.readAction && body.split('\n').some((r) => parseLine(r).kind === 'action')
    return autoAssign([...(hasAct ? [NARRATOR] : []), ...speakersOf(body)])
  }, [body, settings.readAction])

  // ---------- 尺 ----------

  const [durs, setDurs] = useState<Map<string, number>>(() => new Map())
  const [durTick, setDurTick] = useState(0)
  const durKey = (r: TtsReq) => JSON.stringify(r)
  const noteDur = (req: TtsReq, buf: ArrayBuffer) =>
    setDurs((m) => new Map(m).set(durKey(req), wavSeconds(buf)))

  /** その行の長さ。[秒, 実測か] */
  const lineSeconds = (req: TtsReq): [number, boolean] => {
    const d = durs.get(durKey(req))
    return d != null ? [d, true] : [estimateSeconds(req.text, req.speed), false]
  }

  /** その行を読むなら TtsReq、読まない行なら null */
  const reqForLine = (raw: string): TtsReq | null => {
    const l = parseLine(raw)
    if (l.kind === 'dialogue') return reqFor(l.speaker, l.text, meta.voices, auto)
    if (l.kind === 'action' && settings.readAction && speechText(l.text).trim())
      return reqFor(NARRATOR, l.text, meta.voices, auto)
    return null
  }

  /** from 行から to 行まで（読める行だけ）を順に再生する */
  const playRange = async (from: number, to: number) => {
    stop()
    if (rewind) return
    const lines = body.split('\n')
    const targets: { idx: number; req: TtsReq }[] = []
    for (let i = from; i <= Math.min(to, lines.length - 1); i++) {
      const req = reqForLine(lines[i])
      if (req) targets.push({ idx: i, req })
    }
    if (!targets.length) return flash('読み上げる行がありません')

    const p: { cancel: boolean; audio?: HTMLAudioElement } = { cancel: false }
    player.current = p
    setPlaying(targets[0].idx)
    try {
      await ensureServer(serverDir, server, (s) => flash(s, 0))
    } catch (e) {
      player.current = null
      setPlaying(null)
      return flash(String(e instanceof Error ? e.message : e), 8000)
    }
    if (p.cancel) return
    const start = (i: number) => {
      const pr = synth(server, targets[i].req)
      pr.catch(() => {})
      return pr
    }
    let next: Promise<ArrayBuffer> | null = start(0)
    for (let i = 0; i < targets.length; i++) {
      flash(`生成中 ${i + 1}/${targets.length}`, 0)
      let buf: ArrayBuffer
      try {
        buf = await next!
      } catch (e) {
        if (!p.cancel) {
          flash(String(e), 8000)
          player.current = null
          setPlaying(null)
        }
        return
      }
      noteDur(targets[i].req, buf)
      if (p.cancel) return
      next = i + 1 < targets.length ? start(i + 1) : null
      setPlaying(targets[i].idx)
      flash(`▶ ${i + 1}/${targets.length}`, 0)
      try {
        await playBuffer(buf, (a) => (p.audio = a))
      } catch (e) {
        flash(String(e), 6000)
        break
      }
      if (p.cancel) return
    }
    player.current = null
    setPlaying(null)
    setStatus('')
  }

  /** Ctrl+Enter：カーソル行（選択範囲）。toEnd ならカーソル行から最後まで */
  const read = (toEnd: boolean) => {
    const el = ta.current
    if (!el) return
    const lineAt = (pos: number) => body.slice(0, pos).split('\n').length - 1
    const from = lineAt(el.selectionStart)
    return playRange(from, toEnd ? Infinity : lineAt(el.selectionEnd))
  }

  // ---------- 行にホバーすると出る再生ボタン ----------

  const [hover, setHover] = useState<{ idx: number; x: number; y: number } | null>(null)
  const hoverRef = useRef(hover)
  hoverRef.current = hover

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const m = mirror.current
      const stage = m?.parentElement
      if (!m || !stage || overlayRef.current || rewindRef.current) {
        if (hoverRef.current) setHover(null)
        return
      }
      if ((e.target as HTMLElement).closest?.('.lineplay')) return // ボタンの上にいる間はそのまま
      const vertical = dir === 'vertical'
      const sr = stage.getBoundingClientRect()
      const inside = vertical
        ? e.clientY > sr.top - 90 && e.clientY < sr.bottom
        : e.clientX > sr.left - 110 && e.clientX < sr.right
      let best: { idx: number; d: number; el: HTMLElement } | null = null
      if (inside) {
        for (const span of m.querySelectorAll<HTMLElement>('[data-l]')) {
          if (!span.textContent) continue
          const r = span.getBoundingClientRect()
          const [a, b, p] = vertical ? [r.left, r.right, e.clientX] : [r.top, r.bottom, e.clientY]
          const d = p < a ? a - p : p > b ? p - b : 0
          if (!best || d < best.d) best = { idx: Number(span.dataset.l), d, el: span }
          if (d === 0) break
        }
      }
      if (!best || best.d > size * 0.6) {
        if (hoverRef.current) setHover(null)
        return
      }
      const first = best.el.getClientRects()[0]
      const pos = vertical
        ? { x: first.left + first.width / 2, y: Math.max(36, first.top - 4) }
        : { x: first.left - 12, y: first.top + first.height / 2 }
      const h = hoverRef.current
      if (!h || h.idx !== best.idx || Math.abs(h.x - pos.x) > 1 || Math.abs(h.y - pos.y) > 1)
        setHover({ idx: best.idx, ...pos })
    }
    const onLeave = () => setHover(null)
    window.addEventListener('mousemove', onMove)
    document.addEventListener('mouseleave', onLeave)
    return () => {
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseleave', onLeave)
    }
  }, [dir, size])

  // スクロールしたらボタンは一旦消す
  const onEditorScroll = () => {
    syncMirror()
    if (hoverRef.current) setHover(null)
  }


  // ---------- 書き出し ----------

  const [progress, setProgress] = useState<[number, number] | null>(null)

  const allDialogue = () => body.split('\n').flatMap((raw) => reqForLine(raw) ?? [])

  const exportAudio = async (split: boolean) => {
    const items = allDialogue()
    if (!items.length) return flash('セリフがありません')
    const base = (name ?? 'fumi').replace(/\.md$/, '')
    const out = split
      ? await openDialog({ directory: true, title: 'セリフごとのWAVを書き出すフォルダ' })
      : await saveDialog({ defaultPath: `${base}.wav`, filters: [{ name: 'WAV', extensions: ['wav'] }] })
    if (!out || Array.isArray(out)) return
    const un = await listen<[number, number]>('export-progress', (e) => setProgress(e.payload))
    setProgress([0, items.length])
    try {
      await ensureServer(serverDir, server, (s) => flash(s, 0))
      await invoke('export_audio', { server, items, gapMs: GAP_SECONDS * 1000, out, split })
      setDurTick((t) => t + 1)
      flash('書き出しました')
      setOverlay(null)
    } catch (e) {
      flash(String(e instanceof Error ? e.message : e), 8000)
    } finally {
      un()
      setProgress(null)
    }
  }

  // ---------- キー ----------

  const toggle = (o: Overlay) => setOverlay((cur) => (cur === o ? null : o))

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    const act = (fn: () => void) => {
      e.preventDefault()
      e.stopPropagation()
      fn()
    }
    if (rewind) {
      // 履歴を見ている間は編集させない
      if (e.key === 'Escape') return act(() => (setRewind(null), focusEditor()))
      if (e.key === 'Enter') return act(() => void restoreRewind())
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') return act(() => stepRewind(-1))
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') return act(() => stepRewind(1))
      if (!(mod && k === 'h')) return act(() => {})
    }
    if (e.key === 'Escape') {
      if (overlay && !progress) {
        setOverlay(null)
        ta.current?.focus()
      } else stop()
      return
    }
    if (e.key === 'F11') {
      e.preventDefault()
      const w = getCurrentWindow()
      w.isFullscreen().then((f) => w.setFullscreen(!f))
      return
    }
    if (!mod) return
    if (k === '+' || k === '=' || k === ';' || e.code === 'NumpadAdd') return act(() => zoom(1))
    if (k === '-' || e.code === 'NumpadSubtract') return act(() => zoom(-1))
    if (k === '0' || e.code === 'Numpad0') return act(() => zoom(0))
    if (k === 'enter') return act(() => void (tts && read(e.shiftKey)))
    if (k === 'n') return act(() => void newDoc())
    if (k === 'o') return act(() => (e.shiftKey ? void openFile() : toggle('list')))
    if (k === 's') return act(() => void (e.shiftKey ? saveAs() : saveNow()))
    if (k === 't') return act(toggleDirection)
    if (k === 'l' && e.shiftKey) return act(cycleTheme)
    if (k === 'p') return act(() => printScript(body, dir))
    if (k === 'e') return act(() => tts && toggle('export'))
    if (k === 'k') return act(() => tts && toggle('voices'))
    if (k === 'h') return act(() => (rewind ? setRewind(null) : void startRewind()))
    if (k === ',') return act(() => toggle('menu'))
    if (k === '/' || e.code === 'Slash') return act(() => toggle('help'))
  }
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e)
    // 背景クリックで閉じる
    const down = (e: MouseEvent) => {
      if ((e.target as HTMLElement).classList?.contains('overlay')) {
        setOverlay(null)
        focusEditor()
      }
    }
    window.addEventListener('keydown', h, true)
    window.addEventListener('mousedown', down)
    return () => {
      window.removeEventListener('keydown', h, true)
      window.removeEventListener('mousedown', down)
    }
  }, [])

  // ---------- 表示 ----------

  const shown = rewind?.text != null ? parseDoc(rewind.text).body : body
  const html = useMemo(() => highlight(shown), [shown])
  useEffect(syncMirror, [html, dir, size])

  // カーソルのある行（選択範囲の行）だけ記法の記号を見せる
  const [active, setActive] = useState<[number, number] | null>(null)
  useEffect(() => {
    const update = () => {
      const el = ta.current
      if (!el || document.activeElement !== el || rewindRef.current) return setActive(null)
      const v = el.value
      const a = v.slice(0, el.selectionStart).split('\n').length - 1
      const b = a + (v.slice(el.selectionStart, el.selectionEnd).split('\n').length - 1)
      setActive((cur) => (cur && cur[0] === a && cur[1] === b ? cur : [a, b]))
    }
    document.addEventListener('selectionchange', update)
    window.addEventListener('focusin', update)
    window.addEventListener('focusout', update)
    return () => {
      document.removeEventListener('selectionchange', update)
      window.removeEventListener('focusin', update)
      window.removeEventListener('focusout', update)
    }
  }, [])
  useEffect(() => {
    const m = mirror.current
    if (!m) return
    m.querySelectorAll('.act').forEach((e) => e.classList.remove('act'))
    if (!active || rewind) return
    for (let i = active[0]; i <= active[1]; i++) m.querySelector(`[data-l="${i}"]`)?.classList.add('act')
  }, [active, html, rewind])

  // 再生中の行に印をつけ、画面外なら寄せる
  useEffect(() => {
    const m = mirror.current
    if (!m) return
    m.querySelectorAll('.playing').forEach((e) => e.classList.remove('playing'))
    if (playing == null) return
    const span = m.querySelector<HTMLElement>(`[data-l="${playing}"]`)
    if (!span) return
    span.classList.add('playing')
    const r = span.getBoundingClientRect()
    const el = ta.current
    if (!el) return
    if (dir === 'vertical') {
      if (r.right > innerWidth - 40 || r.left < 40) el.scrollLeft += r.left + r.width / 2 - innerWidth / 2
    } else if (r.top < 40 || r.bottom > innerHeight - 40) el.scrollTop += r.top - innerHeight / 3
  }, [playing, html, dir])

  const count = Array.from(shown.replace(/\s/g, '')).length
  const readReqs = useMemo(
    () => body.split('\n').flatMap((raw) => reqForLine(raw) ?? []),
    [body, meta.voices, auto, settings.readAction],
  )
  // 生成済み（キャッシュにある）行の長さを読み込む
  useEffect(() => {
    const t = window.setTimeout(() => {
      invoke<(number | null)[]>('tts_durations', { reqs: readReqs })
        .then((ds) =>
          setDurs((m) => {
            const n = new Map(m)
            ds.forEach((d, i) => d != null && n.set(durKey(readReqs[i]), d))
            return n
          }),
        )
        .catch(() => {})
    }, 500)
    return () => window.clearTimeout(t)
  }, [readReqs, durTick])
  let total = 0
  let estimated = false
  for (const r of readReqs) {
    const [d, real] = lineSeconds(r)
    total += d
    if (!real) estimated = true
  }
  if (readReqs.length > 1) total += GAP_SECONDS * (readReqs.length - 1)
  const hoverReq = hover ? reqForLine(shown.split('\n')[hover.idx] ?? '') : null
  const hoverDur = hoverReq ? lineSeconds(hoverReq) : null
  const hasAction = settings.readAction && body.split('\n').some((r) => parseLine(r).kind === 'action')
  const speakers = [
    ...new Set([...(hasAction ? [NARRATOR] : []), ...speakersOf(body), ...Object.keys(meta.voices ?? {})]),
  ]

  const menuActions: [string, string, () => void][] = [
    ['新規', 'Ctrl+N', () => void newDoc()],
    ['一覧・検索', 'Ctrl+O', () => setOverlay('list')],
    ['保存', 'Ctrl+S', () => (setOverlay(null), void saveNow())],
    ['名前を付けて保存', 'Ctrl+Shift+S', () => (setOverlay(null), void saveAs())],
    ['ファイルを開く', 'Ctrl+Shift+O', () => (setOverlay(null), void openFile())],
    ['履歴', 'Ctrl+H', () => void startRewind()],
    ['PDF', 'Ctrl+P', () => (setOverlay(null), printScript(body, dir))],
    ['書き方・キー一覧', 'Ctrl+/', () => setOverlay('help')],
    ...(tts
      ? ([
          ['読み上げ（カーソル行）', 'Ctrl+Enter', () => (setOverlay(null), void read(false))],
          ['声の割り当て', 'Ctrl+K', () => setOverlay('voices')],
          ['音声書き出し', 'Ctrl+E', () => setOverlay('export')],
        ] as [string, string, () => void][])
      : []),
  ]

  return (
    <div className={`app ${dir} ${rewind ? 'rewinding' : ''}`}>
      <div className="stage" style={{ fontSize: size, visibility: ready ? 'visible' : 'hidden' }}>
        <div ref={mirror} className="pane mirror" aria-hidden dangerouslySetInnerHTML={{ __html: html }} />
        <textarea
          ref={ta}
          className="pane editor"
          value={shown}
          readOnly={!!rewind}
          onChange={(e) => !rewind && edit(e.target.value)}
          onScroll={onEditorScroll}
          spellCheck={false}
          autoFocus
        />
      </div>

      <button className="gear" title="メニュー（Ctrl+,）" onClick={() => toggle('menu')}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      <div className="status">
        {status || (
          <span className="count">
            {count}字
            {tts && readReqs.length > 0 && (
              <span title={estimated ? '生成済みの行は実際の長さ、まだの行は文字数からの目安' : '全行生成済み'}>
                {' · '}
                {estimated ? '約' : ''}
                {fmtSeconds(total)}
              </span>
            )}
          </span>
        )}
      </div>

      {tts && hover && !rewind && !overlay && (
        <div
          className={`lineplay ${dir}`}
          style={{ left: hover.x, top: hover.y }}
          onMouseLeave={(e) => {
            if (!(e.relatedTarget as HTMLElement | null)?.closest?.('.stage')) setHover(null)
          }}
        >
          {playing === hover.idx ? (
            <button className="circle" title="止める（Esc）" onClick={stop}>
              <svg viewBox="0 0 10 10" width="9" height="9"><rect x="1.5" y="1.5" width="7" height="7" fill="currentColor" /></svg>
            </button>
          ) : (
            <>
              <button className="circle" title="この行を読む" onClick={() => void playRange(hover.idx, hover.idx)}>
                <svg viewBox="0 0 10 10" width="10" height="10"><path d="M2.5 1.5 L8.5 5 L2.5 8.5 Z" fill="currentColor" /></svg>
              </button>
              <button className="circle" title="ここから最後まで読む（Escで止まる）" onClick={() => void playRange(hover.idx, Infinity)}>
                <svg viewBox="0 0 12 10" width="12" height="10"><path d="M1 1.5 L5.5 5 L1 8.5 Z M6 1.5 L10.5 5 L6 8.5 Z" fill="currentColor" /></svg>
              </button>
            </>
          )}
          {hoverDur && (
            <span className="dur" title={hoverDur[1] ? '生成した音声の長さ' : '文字数からの目安（まだ生成していません）'}>
              {hoverDur[1] ? '' : '約'}
              {fmtSeconds(hoverDur[0])}
            </span>
          )}
        </div>
      )}

      {playing != null && !rewind && (
        <div className="stopbar">
          <button onClick={stop}>
            ■ 停止 <span className="muted">Esc</span>
          </button>
          <div className="rates" title="再生速度（生成し直さずに速く聞く）">
            {RATES.map((r) => (
              <button key={r} className={rate === r ? 'on' : ''} onClick={() => changeRate(r)}>
                {r}×
              </button>
            ))}
          </div>
        </div>
      )}

      {rewind && (
        <div className="scrubber">
          <span>{fmtTime(rewind.list[0])}</span>
          <div
            className="bar"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              void showSnapshot(rewind, Math.round(((e.clientX - r.left) / r.width) * (rewind.list.length - 1)))
            }}
          >
            {rewind.list.map((ts, i) => (
              <span
                key={ts}
                className={`tick ${i === rewind.idx ? 'cur' : ''}`}
                style={{ left: `${(i / Math.max(1, rewind.list.length - 1)) * 100}%` }}
              />
            ))}
          </div>
          <span>現在</span>
          <span className="when">
            {rewind.idx === rewind.list.length - 1 ? '現在' : fmtTime(rewind.list[rewind.idx])}
            <span className="muted">
              {' '}
              {rewind.idx + 1}/{rewind.list.length}　← → / ホイールで移動　Enter 戻す　Esc やめる
            </span>
          </span>
        </div>
      )}

      {overlay === 'menu' && (
        <Menu
          settings={settings}
          set={set}
          dir={dir}
          actions={menuActions}
          onDirection={toggleDirection}
          onZoom={zoom}
          rate={rate}
          rates={RATES}
          onRate={changeRate}
        />
      )}

      {overlay === 'list' && <FileList current={name} onOpen={openDoc} onNew={newDoc} onOpenFile={() => void openFile()} />}

      {overlay === 'voices' && (
        <Voices
          speakers={speakers}
          voices={meta.voices ?? {}}
          auto={auto}
          server={server}
          serverDir={serverDir}
          onChange={(sp, v) => editMeta((m) => ({ ...m, voices: { ...(m.voices ?? {}), [sp]: v } }))}
          onAudio={noteDur}
          sampleFor={(sp) => {
            const l = body
              .split('\n')
              .map(parseLine)
              .find((l) => (sp === NARRATOR ? l.kind === 'action' : l.kind === 'dialogue' && l.speaker === sp))
            const text = l && (l.kind === 'action' || l.kind === 'dialogue') ? l.text : 'こんにちは。'
            return reqFor(sp, text, meta.voices, auto)
          }}
        />
      )}

      {overlay === 'export' && (
        <div className="overlay">
          <div className="panel small">
            <h2>音声の書き出し</h2>
            <p className="muted">{allDialogue().length} 行（見出し{settings.readAction ? '' : '・ト書き'}は読みません）</p>
            {progress ? (
              <p>
                生成中 {progress[0]} / {progress[1]}
              </p>
            ) : (
              <div className="buttons">
                <button onClick={() => exportAudio(false)}>1本のWAVにまとめる</button>
                <button onClick={() => exportAudio(true)}>セリフごとのWAV</button>
              </div>
            )}
          </div>
        </div>
      )}

      {overlay === 'help' && <Help tts={tts} />}
    </div>
  )
}
