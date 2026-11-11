import { invoke } from '@tauri-apps/api/core'

export type Health = { runtime?: { loaded?: boolean; loading?: boolean } }
export type ServerState = 'stopped' | 'starting' | 'loading' | 'ready' | 'external'

export const STATE_LABEL: Record<ServerState, string> = {
  stopped: '停止中',
  starting: '起動中…',
  loading: 'モデル読み込み中…',
  ready: '準備完了',
  external: '準備完了（外部で起動中）',
}

export function portOf(url: string): number {
  try {
    const u = new URL(url)
    return Number(u.port) || 8088
  } catch {
    return 8088
  }
}

export async function serverState(url: string): Promise<ServerState> {
  const running = await invoke<boolean>('server_running').catch(() => false)
  let h: Health | null = null
  try {
    h = await invoke<Health>('tts_health', { server: url })
  } catch {
    h = null
  }
  if (!h) return running ? 'starting' : 'stopped'
  if (!running) return 'external'
  return h.runtime?.loaded ? 'ready' : 'loading'
}

export function startServer(dir: string, url: string) {
  return invoke<number>('server_start', { dir, port: portOf(url) })
}

export function stopServer() {
  return invoke('server_stop')
}

/** 読み上げの前に呼ぶ。止まっていれば起動して、応答が返るまで待つ。 */
export async function ensureServer(dir: string, url: string, onWait: (s: string) => void): Promise<void> {
  let st = await serverState(url)
  if (st === 'ready' || st === 'external' || st === 'loading') return
  if (st === 'stopped') {
    if (!dir) throw new Error('TTSサーバーが起動していません（左上の歯車から設定）')
    await startServer(dir, url)
  }
  const t0 = Date.now()
  while (Date.now() - t0 < 300_000) {
    st = await serverState(url)
    if (st === 'ready' || st === 'loading' || st === 'external') return
    if (st === 'stopped') throw new Error('TTSサーバーが終了しました（歯車 → ログを確認）')
    onWait(`TTSサーバー${STATE_LABEL[st]}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('TTSサーバーが応答しません')
}
