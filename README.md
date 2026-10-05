# Printer For Jinji

両面PDFを大きい用紙に同じページを複数面並べ、裁断して複数部つくるためのPDFに変換するWebアプリです（例: B6両面 → B4に4面 → 裁断で4部）。
仕様は [SPEC.md](SPEC.md) を参照してください。

## 使い方

`index.html` をブラウザ（Chrome / Edge）で開くだけで使えます。ファイルはブラウザ内だけで処理され、外部には送信されません。
サーバーに置く場合は、このフォルダをそのまま静的ファイルとして公開します。

## 構成

| ファイル | 内容 |
|---|---|
| `index.html` / `css/style.css` | 画面 |
| `js/imposition.js` | 面付けロジック（UI非依存。面数・格子・倍率・回転の計算とPDF生成） |
| `js/app.js` | 画面の操作、プレビュー、ダウンロード |
| `vendor/` | pdf-lib 1.17.1、pdf.js 3.11.174（オフラインで動くよう同梱） |
| `tests/` | `js/imposition.js` のテスト |

## 開発

```bash
node --test
```

ローカルサーバーで確認する場合:

```bash
python -m http.server 8765
```

## GitHub Pages で公開する

ビルドは不要です。リポジトリの内容をそのまま公開します。

1. GitHub で新しいリポジトリを作る（例: `printer-for-jinji`）
2. このフォルダから push する
3. リポジトリの **Settings → Pages** で、Source を「Deploy from a branch」、Branch を `main` / `/ (root)` にして Save
4. 数分後、`https://<ユーザー名>.github.io/<リポジトリ名>/` で開けるようになる

`.nojekyll` は、GitHub Pages の Jekyll 処理を止めてファイルをそのまま配信するためのファイルです。
