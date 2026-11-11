import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import type { Voice } from '../lib/doc'
import { PRESETS, resolveVoice } from '../lib/voices'
import { playBuffer, synth, type TtsReq } from '../App'
import { ensureServer } from '../lib/server'

const ADD = '__add__'

export function Voices(props: {
  speakers: string[]
  voices: Record<string, Voice>
  auto: Map<string, string>
  server: string
  serverDir: string
  onChange: (speaker: string, v: Voice) => void
  sampleFor: (speaker: string) => TtsReq
  onAudio?: (req: TtsReq, buf: ArrayBuffer) => void
}) {
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [files, setFiles] = useState<string[]>([])

  const reloadFiles = () =>
    invoke<string[]>('list_voice_files', { serverDir: props.serverDir })
      .then(setFiles)
      .catch(() => setFiles([]))
  useEffect(() => void reloadFiles(), [props.serverDir])

  /** 音声ファイルを voices フォルダに取り込む。取り込んだ声のIDを返す */
  const addFile = async (): Promise<string | null> => {
    if (!props.serverDir) {
      setMsg('先に歯車メニューで TTSサーバーのフォルダを設定してください')
      return null
    }
    const p = await openDialog({
      title: '声のもとになる音声ファイル（数秒〜数十秒の、その人だけが話している録音）',
      filters: [{ name: '音声', extensions: ['wav', 'flac', 'mp3', 'm4a', 'ogg', 'opus'] }],
    })
    if (typeof p !== 'string') return null
    try {
      const id = await invoke<string>('add_voice_file', { serverDir: props.serverDir, src: p })
      await reloadFiles()
      setMsg(`「${id}」をライブラリに追加しました`)
      return id
    } catch (e) {
      setMsg(String(e))
      return null
    }
  }

  const choose = async (sp: string, value: string) => {
    const v = props.voices[sp] ?? {}
    if (value === '__legacy__') return
    if (value === ADD) {
      const id = await addFile()
      if (id) props.onChange(sp, { note: v.note, use: `file:${id}` })
      return
    }
    // 以前の形式（ref / caption）は選び直したら捨てる
    props.onChange(sp, { note: v.note, use: value || undefined })
  }

  const test = async (sp: string) => {
    setBusy(sp)
    setMsg('')
    try {
      await ensureServer(props.serverDir, props.server, setMsg)
      setMsg('生成中…')
      const req = props.sampleFor(sp)
      const buf = await synth(props.server, req)
      props.onAudio?.(req, buf)
      setMsg('')
      await playBuffer(buf)
    } catch (e) {
      setMsg(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="overlay">
      <div className="panel">
        <h2>声の割り当て</h2>
        {!props.speakers.length && (
          <p className="muted">「名前「セリフ」」の形で書くと、ここに話者が出ます。</p>
        )}
        <table className="voices">
          <tbody>
            {props.speakers.map((sp) => {
              const v = props.voices[sp] ?? {}
              const legacy = !v.use && (v.ref || v.caption)
              const value = v.use ?? (legacy ? '__legacy__' : '')
              return (
                <tr key={sp}>
                  <th>{sp}</th>
                  <td>
                    <select value={value} onChange={(e) => void choose(sp, e.target.value)}>
                      <option value="">{resolveVoice(sp, undefined, props.auto).label}</option>
                      {legacy && <option value="__legacy__">個別指定（以前の設定）</option>}
                      <optgroup label="プリセット">
                        {PRESETS.map((p) => (
                          <option key={p.id} value={`preset:${p.id}`}>
                            {p.label}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="参照音声（ライブラリ）">
                        {files.map((f) => (
                          <option key={f} value={`file:${f}`}>
                            {f}
                          </option>
                        ))}
                        <option value={ADD}>＋ 音声ファイルを追加…</option>
                      </optgroup>
                    </select>
                  </td>
                  <td className="grow">
                    <input
                      placeholder="演技の指示（任意）例: 怒って早口で"
                      value={v.note ?? ''}
                      onChange={(e) => props.onChange(sp, { ...v, note: e.target.value })}
                    />
                  </td>
                  <td className="speed" title="話す速さ（変えると生成し直します）">
                    <input
                      type="range"
                      min={0.5}
                      max={2}
                      step={0.05}
                      value={v.speed ?? 1}
                      onChange={(e) => props.onChange(sp, { ...v, speed: Number(e.target.value) })}
                      onDoubleClick={() => props.onChange(sp, { ...v, speed: 1 })}
                    />
                    <span className="muted">{(v.speed ?? 1).toFixed(2)}×</span>
                  </td>
                  <td>
                    <button disabled={busy !== null} onClick={() => test(sp)}>
                      {busy === sp ? '…' : '▶ 試聴'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="hint muted">
          何も選ばなければ名前から自動で決まります。速さのつまみはダブルクリックで 1.00× に戻ります。プリセットは声の説明文から声を作ります。
          特定の人の声にしたいときは「＋ 音声ファイルを追加…」で、その人だけが話している数秒〜数十秒の録音を選んでください。
        </p>
        {msg && <p className="msg muted">{msg}</p>}
      </div>
    </div>
  )
}
