# Fumi

縦書き・横書きのテキストエディター。必要なら [Irodori-TTS](https://github.com/Aratako/Irodori-TTS) で文章を読み上げられる。

A quiet vertical/horizontal Japanese text editor with optional read-aloud via Irodori-TTS. Windows.

## 特徴

- 縦書き / 横書き（Ctrl + T）。ページの概念はなく、PDF に出すときだけページに割る
- モノクロ。白は白すぎず、黒は黒すぎない
- 書体は PC に入っているものから選べる（★でお気に入り。標準は游明朝）
- 書き始めは下書きとして自動保存。Ctrl + S で場所と名前を決めれば、以降はそのファイルに自動保存。一覧と全文検索
- 履歴を自動で残し、時間をさかのぼって戻せる
- Markdown の見出し・太字などと、ルビ `|漢字《かんじ》`。記号は編集中の行だけ見える
- 読み上げ（オン / オフ）
  - 行にマウスを乗せると ▶（その行）/ ▶▶（そこから最後まで）
  - `名前「セリフ」` は話者ごとの声で、それ以外は「地の文」の声で読む
  - 話者の声は名前から自動で割り当て。プリセットか参照音声から選び直せる
  - 話す速さ、再生速度、行ごと / 全体の尺の表示
  - WAV 書き出し（1本 / 行ごと）

## 書き方

| 書き方 | 意味 |
|---|---|
| `# 見出し` | 見出し・シーン（PDFでは「○見出し」） |
| `名前「セリフ」` | セリフ（PDFでは2行目以降を字下げ） |
| それ以外 | 地の文・ト書き |
| `---` | 改ページ（PDF） |
| `**太字**` `*斜体*` `~~消し~~` | 文字の飾り |
| `\|漢字《かんじ》` | ルビ。読み上げはルビで読む |

## キー

左上の歯車（Ctrl + ,）からすべての操作と設定ができる。

| キー | 動作 |
|---|---|
| Ctrl + N / Ctrl + O | 新規 / 一覧・検索 |
| Ctrl + S | 保存（初回は場所と名前を決める。以降はそのファイルに自動保存） |
| Ctrl + Shift + S / Ctrl + Shift + O | 名前を付けて保存 / ファイルを開く |
| Ctrl + H、Ctrl + Shift + ホイール | 履歴（← → で移動、Enter で戻す、Esc でやめる） |
| Ctrl + T | 縦書き / 横書き |
| Ctrl + + / - / 0 | 文字サイズ |
| Ctrl + P | PDF（印刷 →「PDFとして保存」）。40字×36行 |
| Ctrl + Shift + L | テーマ（黒 / 白 / システム） |
| Ctrl + Enter / Ctrl + Shift + Enter | 読み上げ（カーソル行 / そこから最後まで） |
| Esc | 止める・閉じる |
| Ctrl + K / Ctrl + E | 声の割り当て / 音声書き出し |
| Ctrl + / | キー一覧 |

## 保存場所

| 内容 | 場所 |
|---|---|
| 文章 | Ctrl + S で選んだ場所（`.md` / `.txt`）。`.md` は縦横・声の設定を frontmatter に持つ |
| 下書き | Ctrl + S する前は `ドキュメント\Fumi\YYYY-MM-DD-NNN.md` に自動保存 |
| 履歴 | `%APPDATA%\app.fumi.editor\history\` |
| 音声キャッシュ | `%LOCALAPPDATA%\app.fumi.editor\tts\`（消してよい） |

## 読み上げを使う

1. [Irodori-TTS-Server](https://github.com/Aratako/Irodori-TTS-Server) を入れる（NVIDIA GPU 推奨）

   ```powershell
   git clone https://github.com/Aratako/Irodori-TTS-Server.git
   cd Irodori-TTS-Server
   uv sync --extra cu128
   copy .env.example .env
   ```

2. Fumi の歯車 →「読み上げ」をオン → TTSサーバーの「フォルダ」に上のフォルダを指定（Fumi の近くかホーム直下にあれば自動で見つける）
3. 「起動」。初回はモデルのダウンロードと読み込みに数分かかる。Fumi を閉じるとサーバーも止まる

## ビルド

Node.js 22+、pnpm、Rust が必要。

```powershell
pnpm install
pnpm tauri build --no-bundle   # → src-tauri\target\release\fumi.exe
pnpm tauri dev                 # 開発
```

## 参考

- [Sate](https://github.com/sngazm/sate) — 書くことに集中するエディターのたたずまい、履歴のさかのぼり方
- [Irodori-TTS](https://github.com/Aratako/Irodori-TTS) / [Irodori-TTS-Server](https://github.com/Aratako/Irodori-TTS-Server)

## ライセンス

[MIT](./LICENSE)
