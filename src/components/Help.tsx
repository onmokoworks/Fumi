const SYNTAX: [string, string][] = [
  ['# 見出し', 'シーン（PDFでは ○見出し）'],
  ['名前「セリフ」', 'セリフ（読み上げ対象）'],
  ['それ以外', 'ト書き'],
  ['---', '改ページ（PDF）'],
  ['**太字**  *斜体*  ~~消し~~', '文字の飾り'],
  ['|漢字《かんじ》', 'ルビ（読み上げもルビで読む）'],
]

const KEYS: [string, string][] = [
  ['Ctrl + ,', 'メニュー（左上の歯車）'],
  ['Ctrl + N', '新規'],
  ['Ctrl + O', '一覧・検索'],
  ['Ctrl + S', '保存（初回は場所と名前を決める）'],
  ['Ctrl + Shift + S', '名前を付けて保存'],
  ['Ctrl + Shift + O', 'ファイルを開く'],
  ['Ctrl + H / Ctrl+Shift+ホイール', '履歴をさかのぼる'],
  ['Ctrl + T', '縦書き / 横書き'],
  ['Ctrl + + / Ctrl + -', '文字を大きく / 小さく（Ctrl + 0 で戻す）'],
  ['行にマウスを乗せる', '▶ その行を読む / ▶▶ そこから最後まで読む'],
  ['Ctrl + Enter', 'カーソル行（選択範囲）を読み上げ'],
  ['Ctrl + Shift + Enter', 'カーソル行から最後まで読み上げ'],
  ['Esc', '止める・閉じる'],
  ['Ctrl + K', '声の設定'],
  ['Ctrl + E', '音声の書き出し'],
  ['Ctrl + P', 'PDF（印刷 → PDFとして保存）'],
  ['Ctrl + Shift + L', 'テーマ（黒 / 白 / システム）'],
  ['F11', '全画面'],
]

const Table = ({ rows }: { rows: [string, string][] }) => (
  <table className="keys">
    <tbody>
      {rows.map(([k, v]) => (
        <tr key={k}>
          <th>{k}</th>
          <td>{v}</td>
        </tr>
      ))}
    </tbody>
  </table>
)

export function Help({ tts }: { tts: boolean }) {
  const keys = tts ? KEYS : KEYS.filter(([k, v]) => !/読み上げ|読む|声|音声/.test(v) && !k.includes("Enter"))
  return (
    <div className="overlay">
      <div className="panel small">
        <h2>書き方</h2>
        <Table rows={SYNTAX} />
        <h2>キー</h2>
        <Table rows={keys} />
        <p className="muted">書いている間も自動で保存されます（Ctrl+S で場所を決めるまでは下書きフォルダ）。履歴も自動で残ります（1分ごと）。</p>
      </div>
    </div>
  )
}
