// 実行: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const PDFLib = require('../vendor/pdf-lib.min.js');
const I = require('../js/imposition.js');

const size = (name, o = 'portrait') => I.paperPt(name, o);

async function makeSource(name, pages = 4, orientation = 'portrait', rotate = 0) {
  const doc = await PDFLib.PDFDocument.create();
  const { w, h } = size(name, orientation);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([w, h]);
    p.drawRectangle({ x: 10, y: 10, width: 20, height: 20 });
    if (rotate) p.setRotation(PDFLib.degrees(rotate));
  }
  return doc.save();
}

test('impose: 内容のない白紙ページが混ざっていても変換できる', async () => {
  const doc = await PDFLib.PDFDocument.load(await makeSource('B5', 1));
  const { w, h } = size('B5');
  doc.addPage([w, h]); // Contents なし
  const { info } = await I.impose(await doc.save(), { paper: 'B4' }, PDFLib);
  assert.equal(info.pageCount, 2);
});

test('自動の面数: 等倍で収まる最大の面数を選ぶ', () => {
  const cases = [
    ['B5', 'B4', 2, 'landscape'],
    ['B6', 'B4', 4, 'portrait'],
    ['B7', 'B4', 8, 'landscape'],
    ['A5', 'A4', 2, 'landscape'],
    ['A6', 'A4', 4, 'portrait'],
    ['A5', 'A3', 4, 'portrait'],
  ];
  for (const [src, paper, up, orientation] of cases) {
    const s = size(src);
    const plan = I.choosePlan(paper, s.w, s.h, 'auto');
    assert.equal(plan.up, up, `${src}→${paper}`);
    assert.equal(plan.orientation, orientation, `${src}→${paper}`);
    assert.equal(plan.rotate90, false, `${src}→${paper}`);
    assert.ok(Math.abs(plan.scale - 1) < 0.01, `${src}→${paper} scale=${plan.scale}`);
  }
});

test('自動の面数: 等倍で収まらなければ倍率最大（B5→A4 は2面・約81.6%）', () => {
  const s = size('B5');
  const plan = I.choosePlan('A4', s.w, s.h, 'auto');
  assert.equal(plan.up, 2);
  assert.ok(Math.abs(plan.scale - 0.816) < 0.002, String(plan.scale));
});

test('横向きの元ページは回転せず縦用紙に縦積みする', () => {
  const s = size('B5', 'landscape');
  const plan = I.choosePlan('B4', s.w, s.h, 2);
  assert.equal(plan.orientation, 'portrait');
  assert.equal(plan.cols, 1);
  assert.equal(plan.rows, 2);
  assert.equal(plan.rotate90, false);
});

test('推奨の綴じ方向', () => {
  assert.equal(I.recommendedBinding('landscape'), 'short');
  assert.equal(I.recommendedBinding('portrait'), 'long');
});

test('rotatedOrigin: 回転後の外接矩形が指定位置に来る', () => {
  const w = 100, h = 50, bx = 10, by = 20;
  for (const theta of [0, 90, 180, 270]) {
    const o = I.rotatedOrigin(theta, bx, by, w, h);
    const rad = (theta * Math.PI) / 180;
    const pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => [
      o.x + x * Math.cos(rad) - y * Math.sin(rad),
      o.y + x * Math.sin(rad) + y * Math.cos(rad),
    ]);
    const minX = Math.min(...pts.map((p) => p[0]));
    const minY = Math.min(...pts.map((p) => p[1]));
    assert.ok(Math.abs(minX - bx) < 1e-9 && Math.abs(minY - by) < 1e-9, `theta=${theta}`);
  }
});

test('impose: B6 4ページ → B4縦 4面、ページ数は同じ', async () => {
  const bytes = await makeSource('B6', 4);
  const { bytes: out, info } = await I.impose(bytes, { paper: 'B4' }, PDFLib);
  const doc = await PDFLib.PDFDocument.load(out);
  assert.equal(doc.getPageCount(), 4);
  const { width, height } = doc.getPage(0).getSize();
  const b4 = size('B4');
  assert.ok(Math.abs(width - b4.w) < 0.01 && Math.abs(height - b4.h) < 0.01);
  assert.equal(info.plan.up, 4);
  assert.equal(info.binding, 'long');
  assert.equal(info.sheetCount, 2);
  assert.equal(info.mixed, false);
});

test('impose: 裁断線・確認用番号・推奨以外の綴じ方向でもエラーにならない', async () => {
  const bytes = await makeSource('B5', 3);
  for (const cutLines of ['none', 'full', 'marks']) {
    const { info } = await I.impose(bytes, { paper: 'B4', cutLines, debugNumbers: true, binding: 'other' }, PDFLib);
    assert.equal(info.binding, 'long');
    assert.equal(info.sheetCount, 2);
  }
});

test('impose: /Rotate 付きページは見た目のサイズで扱う', async () => {
  // B5縦の用紙を /Rotate 90 → 見た目は B5横
  const bytes = await makeSource('B5', 2, 'portrait', 90);
  const { info } = await I.impose(bytes, { paper: 'B4', up: 2 }, PDFLib);
  assert.equal(info.sourceLabel, 'B5 横');
  assert.equal(info.plan.orientation, 'portrait');
});

test('impose: サイズ混在を検出する', async () => {
  const doc = await PDFLib.PDFDocument.create();
  const b5 = size('B5'), a4 = size('A4');
  doc.addPage([b5.w, b5.h]);
  doc.addPage([b5.w, b5.h]);
  doc.addPage([a4.w, a4.h]);
  const { info } = await I.impose(await doc.save(), { paper: 'B4' }, PDFLib);
  assert.equal(info.mixed, true);
  assert.deepEqual(info.oddPages, [3]);
});

test('impose: 余白確保・手動の倍率', async () => {
  const bytes = await makeSource('B5', 2);
  const safe = await I.impose(bytes, { paper: 'B4', scaleMode: 'safe', safeRatio: 0.97 }, PDFLib);
  assert.ok(Math.abs(safe.info.maxScale - 0.97) < 0.005);
  const manual = await I.impose(bytes, { paper: 'B4', scaleMode: 'manual', manualPct: 90 }, PDFLib);
  assert.equal(manual.info.maxScale, 0.9);
});

test('makeTestSource: 2ページのPDFを作れる', async () => {
  const s = size('B6');
  const doc = await PDFLib.PDFDocument.load(await I.makeTestSource(s.w, s.h, PDFLib));
  assert.equal(doc.getPageCount(), 2);
});
