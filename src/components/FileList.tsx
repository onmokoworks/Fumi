import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { parseDoc } from '../lib/doc'
import { baseName, isFilePath, recentFiles } from '../App'

type Doc = { name: string; modified: number; content: string }

export function FileList(props: {
  current: string | null
  onOpen: (n: string) => void
  onNew: () => void
  onOpenFile: () => void
}) {
  const [docs, setDocs] = useState<Doc[]>([])
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [folder, setFolder] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Fumi フォルダの下書き＋自分で保存・オープンしたファイル
    Promise.all([
      invoke<Doc[]>('list_docs').catch(() => []),
      invoke<Doc[]>('stat_docs', { paths: recentFiles() }).catch(() => []),
    ]).then(([a, b]) => setDocs([...a, ...b].sort((x, y) => y.modified - x.modified)))
    invoke<string>('docs_folder').then(setFolder).catch(() => {})
    input.current?.focus()
  }, [])

  const items = useMemo(() => {
    const list = docs.map((d) => {
      const body = parseDoc(d.content).body
      const first = body.split('\n').find((l) => l.trim()) ?? ''
      return { ...d, body, first: first.replace(/^\s*#+\s*/, '') }
    })
    const query = q.trim()
    return query ? list.filter((d) => d.body.includes(query) || d.name.includes(query)) : list
  }, [docs, q])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => Math.min(s + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter' && items[sel]) {
      e.preventDefault()
      props.onOpen(items[sel].name)
    }
  }

  const date = (ms: number) => {
    const d = new Date(ms)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  return (
    <div className="overlay">
      <div className="panel">
        <input
          ref={input}
          className="search"
          placeholder="検索"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setSel(0)
          }}
          onKeyDown={onKey}
        />
        <ul className="list">
          {items.map((d, i) => (
            <li
              key={d.name}
              className={`${i === sel ? 'sel' : ''} ${d.name === props.current ? 'cur' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => props.onOpen(d.name)}
              title={isFilePath(d.name) ? d.name : `${folder}\\${d.name}`}
            >
              <span className="first">{d.first || '（空）'}</span>
              <span className="muted where">{isFilePath(d.name) ? baseName(d.name) : '下書き'}</span>
              <span className="muted">{date(d.modified)}</span>
            </li>
          ))}
          {!items.length && <li className="muted">ありません</li>}
        </ul>
        <div className="foot muted">
          <span>下書きの場所: {folder}</span>
          <span className="buttons">
            <button onClick={props.onOpenFile}>ファイルを開く… Ctrl+Shift+O</button>
            <button onClick={props.onNew}>新規 Ctrl+N</button>
          </span>
        </div>
      </div>
    </div>
  )
}
