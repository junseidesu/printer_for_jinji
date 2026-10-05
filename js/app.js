(function () {
  'use strict';

  const I = window.Imposition;
  const $ = (id) => document.getElementById(id);
  const BINDING_NAME = { short: '短辺綴じ', long: '長辺綴じ' };
  const ORIENTATION_NAME = { portrait: '縦', landscape: '横' };

  const state = {
    fileName: null,
    bytes: null,     // 元PDF
    result: null,    // { bytes, info }
    gen: 0,          // 古い変換結果を捨てるための世代番号
    previewDoc: null,
    observer: null,
  };

  // ---------- ファイル読み込み ----------
  const dropzone = $('dropzone');
  const fileInput = $('fileInput');

  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadFile(fileInput.files[0]);
    fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach((t) => dropzone.addEventListener(t, (e) => {
    e.preventDefault(); dropzone.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach((t) => dropzone.addEventListener(t, (e) => {
    e.preventDefault(); dropzone.classList.remove('drag');
  }));
  dropzone.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (f) loadFile(f);
  });
  // ドロップゾーン外に落としたときにブラウザがPDFを開いてしまうのを防ぐ
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  async function loadFile(file) {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      showError('PDFファイルを選んでください。');
      return;
    }
    state.fileName = file.name;
    state.bytes = new Uint8Array(await file.arrayBuffer());
    regenerate();
  }

  // ---------- 設定 ----------
  function readOptions() {
    const scaleMode = document.querySelector('input[name=scaleMode]:checked').value;
    return {
      paper: $('paper').value,
      up: $('up').value === 'auto' ? 'auto' : Number($('up').value),
      scaleMode,
      safeRatio: clamp(Number($('safePct').value) || 97, 50, 100) / 100,
      manualPct: clamp(Number($('manualPct').value) || 100, 10, 400),
      binding: $('binding').value,
      rotateDir: $('rotateDir').value,
      cutLines: $('cutLines').value,
      debugNumbers: $('debugNumbers').checked,
    };
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function syncScaleInputs() {
    const mode = document.querySelector('input[name=scaleMode]:checked').value;
    $('safePct').disabled = mode !== 'safe';
    $('manualPct').disabled = mode !== 'manual';
  }

  let timer = null;
  function scheduleRegenerate() {
    clearTimeout(timer);
    timer = setTimeout(regenerate, 200);
  }
  document.querySelectorAll('.panel select, .panel input:not([type=file])').forEach((el) => {
    el.addEventListener(el.type === 'number' ? 'input' : 'change', () => {
      syncScaleInputs();
      scheduleRegenerate();
    });
  });
  syncScaleInputs();

  // ---------- 変換 ----------
  async function regenerate() {
    if (!state.bytes) return;
    const gen = ++state.gen;
    setBusy(true);
    try {
      const result = await I.impose(state.bytes, readOptions(), window.PDFLib);
      if (gen !== state.gen) return;
      state.result = result;
      hideError();
      renderSourceInfo(result.info);
      renderSummary(result.info);
      await renderPreview(result, gen);
    } catch (err) {
      if (gen !== state.gen) return;
      console.error(err);
      state.result = null;
      $('result').hidden = true;
      $('sourceInfo').hidden = true;
      showError(describeError(err));
    } finally {
      if (gen === state.gen) setBusy(false);
    }
  }

  function describeError(err) {
    const msg = String(err && err.message || err);
    if (/encrypt/i.test(msg)) return 'パスワードで保護されたPDFは読み込めません。保護を解除したPDFを使ってください。';
    if (/No PDF header|Failed to parse|Invalid/i.test(msg)) return 'PDFとして読み込めませんでした。ファイルが壊れていないか確認してください。';
    return `変換できませんでした（${msg}）`;
  }

  function setBusy(busy) {
    $('downloadBtn').disabled = busy;
    $('testBtn').disabled = busy;
  }

  // ---------- 表示 ----------
  function renderSourceInfo(info) {
    const el = $('sourceInfo');
    el.hidden = false;
    el.innerHTML = '';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = state.fileName;
    const dl = document.createElement('dl');
    addRow(dl, 'ページ数', `${info.pageCount} ページ（用紙 ${info.sheetCount} 枚分）`);
    addRow(dl, 'サイズ', info.sourceLabel + (info.mixed ? '（サイズ混在あり）' : ''));
    el.append(name, dl);
  }
  function addRow(dl, k, v) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }

  const pct = (s) => `${Math.round(s * 1000) / 10}%`;

  function renderSummary(info) {
    const p = info.plan;
    $('empty').hidden = true;
    $('result').hidden = false;

    const scaleText = Math.abs(info.maxScale - info.minScale) < 0.001
      ? pct(info.maxScale)
      : `${pct(info.minScale)}〜${pct(info.maxScale)}`;
    $('summaryTitle').textContent = `${p.paper} ${ORIENTATION_NAME[p.orientation]}に ${p.up}面（${p.cols}×${p.rows}）・倍率 ${scaleText}`;
    $('summarySub').textContent = `裁断すると ${p.up} 部できます ／ 出力 ${info.pageCount} ページ = 用紙 ${info.sheetCount} 枚（両面）`;

    // 面数「自動」のときの補足
    $('upHint').textContent = $('up').value === 'auto' ? `→ ${p.up}面を選びました` : '';

    // 綴じ方向の選択肢に実際の名前を出す
    const rec = info.recommendedBinding;
    const other = rec === 'short' ? 'long' : 'short';
    $('binding').options[0].textContent = `${BINDING_NAME[rec]}（推奨）`;
    $('binding').options[1].textContent = `${BINDING_NAME[other]}（裏面を180°回転）`;

    const guide = $('printGuide');
    guide.innerHTML = '';
    [
      `両面印刷で <b>${BINDING_NAME[info.binding]}</b> を選ぶ`,
      `用紙は <b>${p.paper}</b>、倍率は <b>「実際のサイズ」または「100%」</b> を選ぶ（「用紙に合わせる」は使わない）`,
      `最初は「向き確認用PDF」を1枚印刷して、表と裏の上下がそろうか確かめると安心です`,
    ].forEach((html) => {
      const li = document.createElement('li');
      li.innerHTML = html;
      guide.appendChild(li);
    });

    const warnings = [];
    if (info.mixed) {
      const list = info.oddPages.slice(0, 10).join(', ') + (info.oddPages.length > 10 ? ' ほか' : '');
      warnings.push(['warn', `ページサイズが混在しています（${info.sourceLabel} 以外: ${list} ページ）。面の配置は ${info.sourceLabel} に合わせ、それ以外のページは枠に収まるよう倍率を調整しています。`]);
    }
    const opts = readOptions();
    if (opts.scaleMode === 'manual') {
      const s = I.placePage(p, info.sourceSize.w, info.sourceSize.h, opts);
      if (s.scale > s.fit + 1e-6) warnings.push(['warn', `倍率 ${opts.manualPct}% では枠からはみ出します。はみ出した部分は切り取られます（最大 ${pct(s.fit)}）。`]);
    }
    if (opts.scaleMode === 'auto' && info.maxScale >= 0.995) {
      warnings.push(['info', '用紙いっぱいに印刷されるため、プリンターによっては端の数mmが印刷されません。端の内容が切れる場合は「余白確保フィット」を選んでください。']);
    }
    if (info.maxScale > 1.001 && opts.scaleMode !== 'manual') {
      warnings.push(['info', `元のサイズより拡大しています（${pct(info.maxScale)}）。`]);
    }
    if (info.pageCount % 2 === 1) {
      warnings.push(['info', '元PDFのページ数が奇数のため、最後の用紙の裏面は白紙になります。']);
    }
    const ul = $('warnings');
    ul.innerHTML = '';
    for (const [kind, text] of warnings) {
      const li = document.createElement('li');
      if (kind === 'info') li.className = 'info';
      li.textContent = text;
      ul.appendChild(li);
    }
  }

  // ---------- プレビュー ----------
  async function renderPreview(result, gen) {
    if (state.observer) state.observer.disconnect();
    if (state.previewDoc) { state.previewDoc.destroy(); state.previewDoc = null; }

    // pdf.js は渡したバッファを手放すことがあるのでコピーを渡す
    const doc = await pdfjsLib.getDocument({ data: result.bytes.slice() }).promise;
    if (gen !== state.gen) { doc.destroy(); return; }
    state.previewDoc = doc;

    const { plan, pageCount } = result.info;
    const aspect = `${plan.sheetW} / ${plan.sheetH}`;
    const container = $('preview');
    container.innerHTML = '';

    state.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        state.observer.unobserve(entry.target);
        renderThumb(doc, entry.target);
      }
    }, { rootMargin: '300px' });

    for (let s = 0; s < Math.ceil(pageCount / 2); s++) {
      const pair = document.createElement('div');
      pair.className = 'sheet-pair';
      const h = document.createElement('h4');
      h.textContent = `用紙 ${s + 1} 枚目`;
      const sides = document.createElement('div');
      sides.className = 'sides';
      for (const [k, label] of [[0, '表'], [1, '裏']]) {
        const pageNo = s * 2 + k + 1;
        const side = document.createElement('div');
        side.className = 'side';
        const thumb = document.createElement(pageNo <= pageCount ? 'button' : 'div');
        thumb.className = 'thumb';
        thumb.style.aspectRatio = aspect;
        if (pageNo <= pageCount) {
          thumb.type = 'button';
          thumb.dataset.page = pageNo;
          thumb.setAttribute('aria-label', `用紙 ${s + 1} 枚目 ${label}（元 ${pageNo} ページ）を拡大`);
          thumb.addEventListener('click', () => openZoom(pageNo, `用紙 ${s + 1} 枚目・${label}（元PDFの ${pageNo} ページ）`));
          state.observer.observe(thumb);
        } else {
          thumb.classList.add('blank');
          thumb.textContent = '白紙';
        }
        const cap = document.createElement('span');
        cap.textContent = pageNo <= pageCount ? `${label}（p${pageNo}）` : label;
        side.append(thumb, cap);
        sides.appendChild(side);
      }
      pair.append(h, sides);
      container.appendChild(pair);
    }
  }

  async function renderThumb(doc, el) {
    try {
      const page = await doc.getPage(Number(el.dataset.page));
      const cssW = el.clientWidth || 150;
      const canvas = await renderPage(page, cssW);
      if (doc !== state.previewDoc) return;
      el.innerHTML = '';
      el.appendChild(canvas);
    } catch (err) {
      if (doc === state.previewDoc) console.error(err);
    }
  }

  async function renderPage(page, cssWidth, canvas) {
    const base = page.getViewport({ scale: 1 });
    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });
    canvas = canvas || document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return canvas;
  }

  async function openZoom(pageNo, label) {
    const doc = state.previewDoc;
    if (!doc) return;
    const dialog = $('zoom');
    $('zoomLabel').textContent = label;
    const page = await doc.getPage(pageNo);
    const base = page.getViewport({ scale: 1 });
    const maxW = Math.min(window.innerWidth * 0.9 - 32, 1000);
    const maxH = window.innerHeight * 0.9 - 80;
    const cssW = Math.min(maxW, maxH * (base.width / base.height));
    const canvas = $('zoomCanvas');
    canvas.style.width = `${cssW}px`;
    await renderPage(page, cssW, canvas);
    if (!dialog.open) dialog.showModal();
  }
  $('zoom').addEventListener('click', (e) => { if (e.target === $('zoom')) $('zoom').close(); });

  // ---------- ダウンロード ----------
  function download(bytes, name) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function suffix(info) {
    return `${info.plan.paper}_${info.plan.up}up${state.result && readOptions().binding === 'other' ? '_flip' : ''}`;
  }

  $('downloadBtn').addEventListener('click', () => {
    if (!state.result) return;
    const base = state.fileName.replace(/\.pdf$/i, '');
    download(state.result.bytes, `${base}_${suffix(state.result.info)}.pdf`);
  });

  $('testBtn').addEventListener('click', async () => {
    if (!state.result) return;
    const { w, h } = state.result.info.sourceSize;
    const opts = readOptions();
    const testSrc = await I.makeTestSource(w, h, window.PDFLib);
    // 確認用なので倍率は常に自動フィット、ページ番号は出さない
    const { bytes, info } = await I.impose(testSrc, { ...opts, scaleMode: 'auto', debugNumbers: false }, window.PDFLib);
    download(bytes, `向き確認_${suffix(info)}.pdf`);
  });

  // ---------- エラー ----------
  function showError(msg) {
    const el = $('error');
    el.textContent = msg;
    el.hidden = false;
    if (!state.result) $('empty').hidden = false;
  }
  function hideError() { $('error').hidden = true; }
})();
