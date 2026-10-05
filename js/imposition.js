/*
 * 面付けロジック（UI非依存）
 * ブラウザでは window.Imposition、Node では module.exports として使う。
 * PDF の生成には pdf-lib（PDFLib）を引数で受け取る。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Imposition = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MM = 72 / 25.4; // 1mm あたりの pt

  // 縦向きの [幅, 高さ] mm（B は JIS）
  const PAPERS = {
    A3: [297, 420], A4: [210, 297], A5: [148, 210], A6: [105, 148], A7: [74, 105],
    B4: [257, 364], B5: [182, 257], B6: [128, 182], B7: [91, 128],
  };
  const OUTPUT_PAPERS = ['A3', 'B4', 'A4', 'B5'];
  const UP_COUNTS = [2, 4, 8];
  // 面数ごとの格子 [列, 行]
  const GRIDS = { 2: [[2, 1], [1, 2]], 4: [[2, 2]], 8: [[4, 2], [2, 4]] };
  // この倍率以上なら「等倍で収まる」とみなす（B6 128mm → B4/4 128.5mm などの端数を吸収）
  const SAME_SIZE_THRESHOLD = 0.995;
  const EPS = 1e-6;

  function paperPt(name, orientation) {
    const [w, h] = PAPERS[name].map((v) => v * MM);
    return orientation === 'landscape' ? { w: h, h: w } : { w, h };
  }

  /** pt のサイズから定形サイズ名を推定する（許容差 3mm） */
  function detectPaper(wPt, hPt) {
    const w = wPt / MM, h = hPt / MM;
    const tol = 3;
    for (const [name, [pw, ph]] of Object.entries(PAPERS)) {
      if (Math.abs(w - pw) <= tol && Math.abs(h - ph) <= tol) return { name, orientation: 'portrait' };
      if (Math.abs(w - ph) <= tol && Math.abs(h - pw) <= tol) return { name, orientation: 'landscape' };
    }
    return null;
  }

  function sizeLabel(wPt, hPt) {
    const p = detectPaper(wPt, hPt);
    if (p) return `${p.name} ${p.orientation === 'portrait' ? '縦' : '横'}`;
    return `${Math.round(wPt / MM)}×${Math.round(hPt / MM)}mm`;
  }

  function fitScale(pw, ph, cw, ch, rot90) {
    const w = rot90 ? ph : pw, h = rot90 ? pw : ph;
    return Math.min(cw / w, ch / h);
  }

  /** 指定の面数で、倍率が最大になる用紙の向き・格子・回転を求める */
  function planForUp(paper, srcW, srcH, up) {
    let best = null;
    for (const [cols, rows] of GRIDS[up]) {
      for (const orientation of ['portrait', 'landscape']) {
        const sheet = paperPt(paper, orientation);
        const cw = sheet.w / cols, ch = sheet.h / rows;
        for (const rotate90 of [false, true]) {
          const scale = fitScale(srcW, srcH, cw, ch, rotate90);
          const cand = { paper, up, cols, rows, orientation, sheetW: sheet.w, sheetH: sheet.h, cellW: cw, cellH: ch, rotate90, scale };
          // 同じ倍率なら回転しない配置を優先する
          if (!best || scale > best.scale + EPS || (Math.abs(scale - best.scale) <= EPS && best.rotate90 && !rotate90)) {
            best = cand;
          }
        }
      }
    }
    return best;
  }

  /**
   * 面数を決める。up が 'auto' なら、等倍で収まる最大の面数、
   * 等倍で収まるものがなければ倍率が最大の面数を選ぶ。
   */
  function choosePlan(paper, srcW, srcH, up) {
    if (up !== 'auto') return planForUp(paper, srcW, srcH, Number(up));
    const plans = UP_COUNTS.map((n) => planForUp(paper, srcW, srcH, n));
    const sameSize = plans.filter((p) => p.scale >= SAME_SIZE_THRESHOLD);
    if (sameSize.length) return sameSize[sameSize.length - 1];
    return plans.reduce((a, b) => (b.scale > a.scale + EPS ? b : a));
  }

  /** 横向き用紙は短辺綴じ、縦向き用紙は長辺綴じで裏面が正立する */
  function recommendedBinding(orientation) {
    return orientation === 'landscape' ? 'short' : 'long';
  }

  /** 1ページ分の配置（回転・倍率）。ページサイズが混在しても格子は plan で共通 */
  function placePage(plan, pageW, pageH, opts) {
    const fitNo = fitScale(pageW, pageH, plan.cellW, plan.cellH, false);
    const fitRot = fitScale(pageW, pageH, plan.cellW, plan.cellH, true);
    const rotate90 = fitRot > fitNo + EPS;
    const fit = Math.max(fitNo, fitRot);
    let scale = fit;
    if (opts.scaleMode === 'safe') scale = fit * opts.safeRatio;
    else if (opts.scaleMode === 'manual') scale = opts.manualPct / 100;
    return { rotate90, scale, fit };
  }

  /** 各枠の左下座標（PDF座標系）。左上の枠から行ごとに並べる */
  function cellOrigins(plan) {
    const cells = [];
    for (let r = 0; r < plan.rows; r++) {
      for (let c = 0; c < plan.cols; c++) {
        cells.push({ x: c * plan.cellW, y: plan.sheetH - (r + 1) * plan.cellH });
      }
    }
    return cells;
  }

  /**
   * 反時計回りに theta 度回転して描くとき、回転後の外接矩形の左下を (bx, by) に置くための
   * drawPage の原点を返す。w, h は回転前の（倍率適用後の）サイズ。
   */
  function rotatedOrigin(theta, bx, by, w, h) {
    switch (theta) {
      case 90: return { x: bx + h, y: by };
      case 180: return { x: bx + w, y: by + h };
      case 270: return { x: bx, y: by + w };
      default: return { x: bx, y: by };
    }
  }

  const norm = (deg) => ((deg % 360) + 360) % 360;

  const DEFAULT_OPTIONS = {
    paper: 'B4',
    up: 'auto',            // 'auto' | 2 | 4 | 8
    scaleMode: 'auto',     // 'auto' | 'safe' | 'manual'
    safeRatio: 0.97,
    manualPct: 100,
    rotateDir: 'ccw',      // 横向きページを枠に合わせるときの回転方向: 'ccw' 左回転 / 'cw' 右回転
    binding: 'recommended',// 'recommended' | 'other'
    cutLines: 'none',      // 'none' | 'full' | 'marks'
    debugNumbers: false,
  };

  /** 元PDFのページ情報（/Rotate を反映した見た目のサイズ）を集める */
  function analyzePages(srcDoc) {
    return srcDoc.getPages().map((page, i) => {
      const crop = page.getCropBox();
      const rotation = norm(page.getRotation().angle);
      const swap = rotation === 90 || rotation === 270;
      return {
        index: i,
        crop,
        rotation,
        w: swap ? crop.height : crop.width,
        h: swap ? crop.width : crop.height,
      };
    });
  }

  /** 最も多いページサイズ（mm単位で丸めて比較） */
  function dominantSize(pages) {
    const counts = new Map();
    for (const p of pages) {
      const key = `${Math.round(p.w / MM)}x${Math.round(p.h / MM)}`;
      const e = counts.get(key) || { n: 0, w: p.w, h: p.h };
      e.n++;
      counts.set(key, e);
    }
    let best = null;
    for (const [key, e] of counts) if (!best || e.n > best.n) best = { key, ...e };
    return { main: best, distinct: counts.size };
  }

  /**
   * 面付けを実行する。
   * @returns {{ bytes: Uint8Array, info: object }}
   */
  async function impose(srcBytes, options, PDFLib) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const { PDFDocument, degrees, rgb, StandardFonts,
      pushGraphicsState, popGraphicsState, rectangle, clip, endPath } = PDFLib;

    const src = await PDFDocument.load(srcBytes);
    const pages = analyzePages(src);
    if (pages.length === 0) throw new Error('ページがありません');

    const { main, distinct } = dominantSize(pages);
    const plan = choosePlan(opts.paper, main.w, main.h, opts.up);
    const recBinding = recommendedBinding(plan.orientation);
    const binding = opts.binding === 'recommended' ? recBinding : (recBinding === 'short' ? 'long' : 'short');
    const flipBack = opts.binding !== 'recommended';

    const mainKey = main.key;
    const odd = pages.filter((p) => `${Math.round(p.w / MM)}x${Math.round(p.h / MM)}` !== mainKey).map((p) => p.index + 1);

    const out = await PDFDocument.create();
    // 内容のない白紙ページは埋め込めないので、描画しない
    const srcPages = src.getPages();
    const withContents = pages.filter((p) => srcPages[p.index].node.Contents());
    const embeddedList = await out.embedPages(
      withContents.map((p) => srcPages[p.index]),
      withContents.map((p) => ({ left: p.crop.x, bottom: p.crop.y, right: p.crop.x + p.crop.width, top: p.crop.y + p.crop.height })),
    );
    const embedded = new Map(withContents.map((p, k) => [p.index, embeddedList[k]]));
    const font = opts.debugNumbers ? await out.embedFont(StandardFonts.Helvetica) : null;
    const cells = cellOrigins(plan);
    const pageScales = [];

    pages.forEach((p, i) => {
      const sheet = out.addPage([plan.sheetW, plan.sheetH]);
      const place = placePage(plan, p.w, p.h, opts);
      pageScales.push(place.scale);
      const isBack = i % 2 === 1;
      // PDF の /Rotate は時計回り表示なので、描画は反時計回りに -rotation
      const extra = place.rotate90 ? (opts.rotateDir === 'ccw' ? 90 : 270) : 0;
      const theta = norm(-p.rotation + extra + (isBack && flipBack ? 180 : 0));
      const w0 = p.crop.width * place.scale, h0 = p.crop.height * place.scale;
      const boxW = theta % 180 === 0 ? w0 : h0;
      const boxH = theta % 180 === 0 ? h0 : w0;

      for (const cell of cells) {
        const bx = cell.x + (plan.cellW - boxW) / 2;
        const by = cell.y + (plan.cellH - boxH) / 2;
        const o = rotatedOrigin(theta, bx, by, w0, h0);
        // はみ出しても隣の枠に重ならないよう、枠で切り抜く
        const ep = embedded.get(i);
        if (ep) {
          sheet.pushOperators(pushGraphicsState(), rectangle(cell.x, cell.y, plan.cellW, plan.cellH), clip(), endPath());
          sheet.drawPage(ep, { x: o.x, y: o.y, xScale: place.scale, yScale: place.scale, rotate: degrees(theta) });
          sheet.pushOperators(popGraphicsState());
        }
        if (font) {
          sheet.drawText(`p${i + 1}`, { x: cell.x + 6 * MM, y: cell.y + 6 * MM, size: 9, font, color: rgb(0.85, 0, 0) });
        }
      }
      drawCutLines(sheet, plan, opts.cutLines, rgb);
    });

    const bytes = await out.save();
    return {
      bytes,
      info: {
        plan,
        binding,
        recommendedBinding: recBinding,
        pageCount: pages.length,
        sheetCount: Math.ceil(pages.length / 2),
        sourceLabel: sizeLabel(main.w, main.h),
        sourceSize: { w: main.w, h: main.h },
        mixed: distinct > 1,
        oddPages: odd,
        minScale: Math.min(...pageScales),
        maxScale: Math.max(...pageScales),
      },
    };
  }

  function drawCutLines(sheet, plan, mode, rgb) {
    if (mode === 'none') return;
    const style = { thickness: 0.3, color: rgb(0.45, 0.45, 0.45), dashArray: [3, 3] };
    const len = 12 * MM; // トンボ風の線の長さ
    const lines = [];
    for (let c = 1; c < plan.cols; c++) {
      const x = c * plan.cellW;
      if (mode === 'full') lines.push([x, 0, x, plan.sheetH]);
      else lines.push([x, 0, x, len], [x, plan.sheetH - len, x, plan.sheetH]);
    }
    for (let r = 1; r < plan.rows; r++) {
      const y = r * plan.cellH;
      if (mode === 'full') lines.push([0, y, plan.sheetW, y]);
      else lines.push([0, y, len, y], [plan.sheetW - len, y, plan.sheetW, y]);
    }
    for (const [x1, y1, x2, y2] of lines) {
      sheet.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, ...style });
    }
  }

  /** 向き確認用の2ページの元PDF（表/裏、上向き矢印）を作る */
  async function makeTestSource(wPt, hPt, PDFLib) {
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    for (const label of ['FRONT', 'BACK']) {
      const page = doc.addPage([wPt, hPt]);
      const s = Math.min(wPt, hPt);
      const color = label === 'FRONT' ? rgb(0.1, 0.3, 0.8) : rgb(0.8, 0.2, 0.1);
      page.drawRectangle({ x: 4, y: 4, width: wPt - 8, height: hPt - 8, borderColor: color, borderWidth: 2 });
      // 上向き矢印（drawSvgPath は y 軸下向きの SVG 座標）
      const a = s * 0.18;
      const cx = wPt / 2, top = hPt * 0.88;
      page.drawSvgPath(`M 0 0 L ${a} ${a} L ${a * 0.4} ${a} L ${a * 0.4} ${a * 2} L ${-a * 0.4} ${a * 2} L ${-a * 0.4} ${a} L ${-a} ${a} Z`, { x: cx, y: top, color });
      const big = s * 0.13;
      const tw = font.widthOfTextAtSize(label, big);
      page.drawText(label, { x: cx - tw / 2, y: hPt * 0.4, size: big, font, color });
      const small = s * 0.07;
      const top2 = 'TOP';
      page.drawText(top2, { x: cx - font.widthOfTextAtSize(top2, small) / 2, y: top - a * 2 - small * 1.6, size: small, font, color });
    }
    return doc.save();
  }

  return {
    MM, PAPERS, OUTPUT_PAPERS, UP_COUNTS, DEFAULT_OPTIONS,
    paperPt, detectPaper, sizeLabel, planForUp, choosePlan, recommendedBinding,
    placePage, rotatedOrigin, impose, makeTestSource,
  };
});
