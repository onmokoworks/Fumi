import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { STATE_LABEL, serverState, startServer, stopServer, type ServerState } from '../lib/server'
import type { Direction } from '../lib/doc'

export type Theme = 'system' | 'light' | 'dark'

export type Settings = {
  theme: Theme
  size: number
  server: string
  serverDir: string
  autostart: boolean
  readAction: boolean
  tts: boolean
}

export function Menu(props: {
  settings: Settings
  set: (p: Partial<Settings>) => void
  dir: Direction
  actions: [string, string, () => void][]
  onDirection: () => void
  onZoom: (d: number) => void
  rate: number
  rates: number[]
  onRate: (r: number) => void
}) {
  const s = props.settings
  const [state, setState] = useState<ServerState>('stopped')
  const [log, setLog] = useState('')
  const [showLog, setShowLog] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!s.tts) return
    let alive = true
    const tick = async () => {
      const st = await serverState(s.server)
      if (!alive) return
      setState(st)
      if (showLog) setLog(await invoke<string>('server_log').catch(() => ''))
    }
    tick()
    const t = window.setInterval(tick, 1500)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [s.server, s.tts, showLog])

  const setTts = async (on: boolean) => {
    // オフにしたら、このアプリが起動したサーバーも止める
    if (!on) await stopServer().catch(() => {})
    props.set({ tts: on })
  }

  const on = state !== 'stopped'
  const toggle = async () => {
    setErr('')
    try {
      if (on) await stopServer()
      else await startServer(s.serverDir, s.server)
      setState(await serverState(s.server))
    } catch (e) {
      setErr(String(e))
    }
  }

  const pickDir = async () => {
    const p = await openDialog({ directory: true, title: 'Irodori-TTS-Server のフォルダ' })
    if (typeof p === 'string') props.set({ serverDir: p })
  }

  return (
    <div className="overlay">
      <div className="panel menu">
        <section>
          <h2>操作</h2>
          <div className="actions">
            {props.actions.map(([label, key, fn]) => (
              <button key={label} onClick={fn}>
                <span>{label}</span>
                <span className="muted">{key}</span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2>表示</h2>
          <div className="row">
            <span className="label">向き</span>
            <div className="seg">
              <button className={props.dir === 'vertical' ? 'on' : ''} onClick={() => props.dir !== 'vertical' && props.onDirection()}>
                縦書き
              </button>
              <button className={props.dir === 'horizontal' ? 'on' : ''} onClick={() => props.dir !== 'horizontal' && props.onDirection()}>
                横書き
              </button>
            </div>
          </div>
          <div className="row">
            <span className="label">テーマ</span>
            <div className="seg">
              {(['dark', 'light', 'system'] as Theme[]).map((t) => (
                <button key={t} className={s.theme === t ? 'on' : ''} onClick={() => props.set({ theme: t })}>
                  {t === 'dark' ? '黒' : t === 'light' ? '白' : 'システム'}
                </button>
              ))}
            </div>
          </div>
          <div className="row">
            <span className="label">文字</span>
            <div className="seg">
              <button onClick={() => props.onZoom(-1)}>－</button>
              <button onClick={() => props.onZoom(0)}>{s.size}px</button>
              <button onClick={() => props.onZoom(1)}>＋</button>
            </div>
          </div>
        </section>

        <section>
          <h2>読み上げ</h2>
          <div className="row">
            <span className="label">読み上げ</span>
            <div className="seg">
              <button className={!s.tts ? 'on' : ''} onClick={() => void setTts(false)}>
                オフ
              </button>
              <button className={s.tts ? 'on' : ''} onClick={() => void setTts(true)}>
                オン
              </button>
            </div>
            {!s.tts && <span className="muted hint">オンにすると Irodori-TTS で文章を声で確かめられます</span>}
          </div>
          {s.tts && (
            <>
              <div className="row">
                <span className="label">再生速度</span>
                <div className="seg">
                  {props.rates.map((r) => (
                    <button key={r} className={props.rate === r ? 'on' : ''} onClick={() => props.onRate(r)}>
                      {r}×
                    </button>
                  ))}
                </div>
              </div>
              <label className="row check">
                <input type="checkbox" checked={s.readAction} onChange={(e) => props.set({ readAction: e.target.checked })} />
                ト書き（「」のない行）も「地の文」の声で読む
              </label>
            </>
          )}
        </section>

        {s.tts && (
        <section>
          <h2>TTSサーバー</h2>
          <div className="row">
            <span className="label">状態</span>
            <span className={`dot ${state}`} />
            <span className="grow">{STATE_LABEL[state]}</span>
            <button onClick={toggle} disabled={state === 'external'}>
              {on ? '停止' : '起動'}
            </button>
          </div>
          <div className="row">
            <span className="label">フォルダ</span>
            <input className="grow" value={s.serverDir} onChange={(e) => props.set({ serverDir: e.target.value })} />
            <button onClick={pickDir}>選択…</button>
          </div>
          <div className="row">
            <span className="label">URL</span>
            <input className="grow" value={s.server} onChange={(e) => props.set({ server: e.target.value })} />
          </div>
          <label className="row check">
            <input type="checkbox" checked={s.autostart} onChange={(e) => props.set({ autostart: e.target.checked })} />
            アプリを開いたら起動する（閉じると止まります）
          </label>
          <div className="row">
            <button className="link" onClick={() => setShowLog((v) => !v)}>
              {showLog ? 'ログを隠す' : 'ログを見る'}
            </button>
          </div>
          {err && <p className="msg">{err}</p>}
          {showLog && <pre className="log">{log || '（ログなし）'}</pre>}
          {!s.serverDir && (
            <p className="hint muted">
              Irodori-TTS-Server（github.com/Aratako/Irodori-TTS-Server）を入れたフォルダを指定してください。
            </p>
          )}
        </section>
        )}
      </div>
    </div>
  )
}
