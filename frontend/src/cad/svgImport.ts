/**
 * SVG 가져오기 (일러스트·로고·레이저 커팅 도안 → 스케치): DXF 가져오기와 같은 도형 묶음(DxfShapes)으로 읽어
 * 같은 규칙(이어 붙이기 → 닫힌 다각형·열린 경로, 원·타원)으로 스케치 명령을 만든다. 저장 형식은 그대로.
 *
 * - 요소: path(M L H V C S Q T A Z, 상대·절대), rect(둥근 모서리), circle, ellipse, line, polyline, polygon
 * - transform(matrix·translate·scale·rotate·skewX·skewY), 중첩 <g>, viewBox + width/height 단위(mm·cm·in·pt·px) → mm
 * - 원호(rx = ry, 닮음 변환)는 호 변(bulge) 그대로, 그 밖의 곡선(베지어·타원 호)은 잘게 꺾어 넣는다 (이후 단순화)
 * - defs·clipPath·mask·symbol·pattern·marker 안과 display="none" 은 건너뛴다. SVG 는 y 가 아래 → 스케치 v 는 위
 */
import type { Point2 } from './commandTypes';
import type { DxfSeg, DxfShapes } from './dxfImport';

/** 2D 아핀 [a b c d e f]: x' = a x + c y + e, y' = b x + d y + f */
type Mat = [number, number, number, number, number, number];
const I: Mat = [1, 0, 0, 1, 0, 0];
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Mat, p: Point2): Point2 => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
const det = (m: Mat) => m[0] * m[3] - m[1] * m[2];
/** 닮음 변환(회전·균일 배율·뒤집기)이면 배율, 아니면 null */
function similarity(m: Mat): number | null {
  const sx = Math.hypot(m[0], m[1]);
  const sy = Math.hypot(m[2], m[3]);
  const dotp = m[0] * m[2] + m[1] * m[3];
  return Math.abs(sx - sy) <= 1e-9 * Math.max(sx, sy, 1) && Math.abs(dotp) <= 1e-9 * sx * sy + 1e-15 ? sx : null;
}

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
const nums = (s: string | undefined) => (s ?? '').match(NUM)?.map(Number) ?? [];

function parseTransform(s: string | undefined): Mat {
  let m = I;
  if (!s) return m;
  for (const [, fn, args] of s.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const a = nums(args);
    let t: Mat = I;
    if (fn === 'matrix' && a.length >= 6) t = [a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!];
    else if (fn === 'translate') t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
    else if (fn === 'scale') t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
    else if (fn === 'rotate') {
      const r = ((a[0] ?? 0) * Math.PI) / 180;
      const [c, sn] = [Math.cos(r), Math.sin(r)];
      const [cx, cy] = [a[1] ?? 0, a[2] ?? 0];
      t = mul(mul([1, 0, 0, 1, cx, cy], [c, sn, -sn, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
    } else if (fn === 'skewX') t = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
    else if (fn === 'skewY') t = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    m = mul(m, t);
  }
  return m;
}

const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 };
function lengthMm(s: string | undefined): number | null {
  const m = s?.trim().match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(mm|cm|in|pt|pc|px)?$/);
  if (!m) return null;
  return Number(m[1]) * UNIT_MM[m[2] ?? '']!;
}

function attrsOf(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, k, , v1, v2] of s.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[k!] = (v1 ?? v2 ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  return out;
}

const SKIP = new Set(['defs', 'clipPath', 'mask', 'symbol', 'pattern', 'marker', 'title', 'desc', 'metadata', 'style', 'linearGradient', 'radialGradient', 'filter', 'text']);

export function parseSvg(text: string): DxfShapes {
  const src = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  if (!/<svg[\s>]/i.test(src)) throw new Error('SVG 형식이 아닙니다 (<svg> 요소가 없습니다)');
  const segs: DxfSeg[] = [];
  const circles: DxfShapes['circles'] = [];
  const ellipses: DxfShapes['ellipses'] = [];
  const skipped: Record<string, number> = {};
  const stack: { m: Mat; skip: boolean; tag: string }[] = [];
  let unitLabel = 'px';
  const cur = () => stack[stack.length - 1] ?? { m: I, skip: false, tag: '' };

  const emitLine = (m: Mat, a: Point2, b: Point2) => {
    const A = apply(m, a);
    const B = apply(m, b);
    if (Math.hypot(B[0] - A[0], B[1] - A[1]) > 1e-9) segs.push({ a: A, b: B, bulge: 0 });
  };
  const emitPolyline = (m: Mat, pts: Point2[]) => {
    for (let k = 1; k < pts.length; k++) emitLine(m, pts[k - 1]!, pts[k]!);
  };
  /** 꺾는 조각 수: 최종 mm 길이 기준 (짧은 곡선은 적게) */
  const pieces = (m: Mat, len: number) => {
    const s = Math.sqrt(Math.abs(det(m))) || 1;
    return Math.max(2, Math.min(24, Math.ceil((len * s) / 1.5)));
  };

  /** SVG 호 (끝점 매개 → 중심 매개, SVG 사양 F.6.5) */
  const arc = (m: Mat, p0: Point2, rx0: number, ry0: number, phiDeg: number, large: boolean, sweep: boolean, p1: Point2) => {
    if (rx0 === 0 || ry0 === 0) return emitLine(m, p0, p1);
    let rx = Math.abs(rx0);
    let ry = Math.abs(ry0);
    const phi = (phiDeg * Math.PI) / 180;
    const [c, s] = [Math.cos(phi), Math.sin(phi)];
    const dx = (p0[0] - p1[0]) / 2;
    const dy = (p0[1] - p1[1]) / 2;
    const x1 = c * dx + s * dy;
    const y1 = -s * dx + c * dy;
    const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lam > 1) [rx, ry] = [rx * Math.sqrt(lam), ry * Math.sqrt(lam)];
    const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
    const cx1 = (co * rx * y1) / ry;
    const cy1 = (-co * ry * x1) / rx;
    const cx = c * cx1 - s * cy1 + (p0[0] + p1[0]) / 2;
    const cy = s * cx1 + c * cy1 + (p0[1] + p1[1]) / 2;
    const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
    let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    if (sweep && dt < 0) dt += 2 * Math.PI;
    const at = (t: number): Point2 => [cx + rx * Math.cos(t) * c - ry * Math.sin(t) * s, cy + rx * Math.cos(t) * s + ry * Math.sin(t) * c];
    const sim = similarity(m);
    if (Math.abs(rx - ry) <= 1e-9 * rx && sim !== null) {
      // 원호: 반원 이하 조각의 bulge (SVG 좌표에서 양의 각 = 반시계 수학 방향, 변환이 뒤집으면 부호 반대)
      const n = Math.max(1, Math.ceil(Math.abs(dt) / Math.PI - 1e-9));
      const sign = Math.sign(det(m));
      for (let k = 0; k < n; k++) {
        const a = apply(m, k === 0 ? p0 : at(t1 + (dt * k) / n));
        const b = apply(m, k === n - 1 ? p1 : at(t1 + (dt * (k + 1)) / n));
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-9) segs.push({ a, b, bulge: Math.tan(dt / n / 4) * sign });
      }
      return;
    }
    const n = pieces(m, Math.abs(dt) * Math.max(rx, ry));
    const pts = Array.from({ length: n + 1 }, (_, k) => (k === 0 ? p0 : k === n ? p1 : at(t1 + (dt * k) / n)));
    emitPolyline(m, pts);
  };

  const path = (m: Mat, d: string) => {
    let i = 0;
    const ws = () => {
      while (i < d.length && /[\s,]/.test(d[i]!)) i++;
    };
    const num = (): number => {
      ws();
      NUM.lastIndex = i;
      const r = NUM.exec(d);
      if (!r || r.index !== i) throw new Error(`SVG 경로 숫자를 읽지 못했습니다 (${i}번째 글자)`);
      i += r[0].length;
      return Number(r[0]);
    };
    const flag = (): boolean => {
      ws();
      const ch = d[i++];
      if (ch !== '0' && ch !== '1') throw new Error('SVG 호 플래그가 잘못되었습니다');
      return ch === '1';
    };
    const more = () => {
      ws();
      return i < d.length && /[-+.\d]/.test(d[i]!);
    };
    let p: Point2 = [0, 0];
    let start: Point2 = [0, 0];
    let lastCtrl: Point2 | null = null;
    let lastCmd = '';
    while (true) {
      ws();
      if (i >= d.length) break;
      let cmd = d[i]!;
      if (/[a-zA-Z]/.test(cmd)) i++;
      else if (lastCmd) cmd = lastCmd === 'M' ? 'L' : lastCmd === 'm' ? 'l' : lastCmd; // 이어지는 좌표
      else throw new Error('SVG 경로가 명령으로 시작하지 않습니다');
      const rel = cmd === cmd.toLowerCase();
      const C = cmd.toUpperCase();
      const pt = (): Point2 => {
        const x = num();
        const y = num();
        return rel ? [p[0] + x, p[1] + y] : [x, y];
      };
      if (C === 'Z') {
        emitLine(m, p, start);
        p = start;
        lastCtrl = null;
        lastCmd = cmd;
        continue;
      }
      do {
        if (C === 'M') {
          p = start = pt();
          lastCtrl = null;
          if (more()) {
            cmd = rel ? 'l' : 'L';
            lastCmd = cmd;
            do {
              const q = pt();
              emitLine(m, p, q);
              p = q;
            } while (more());
          }
          break;
        } else if (C === 'L') {
          const q = pt();
          emitLine(m, p, q);
          p = q;
          lastCtrl = null;
        } else if (C === 'H') {
          const x = num();
          const q: Point2 = [rel ? p[0] + x : x, p[1]];
          emitLine(m, p, q);
          p = q;
          lastCtrl = null;
        } else if (C === 'V') {
          const y = num();
          const q: Point2 = [p[0], rel ? p[1] + y : y];
          emitLine(m, p, q);
          p = q;
          lastCtrl = null;
        } else if (C === 'C' || C === 'S') {
          const c1: Point2 =
            C === 'C' ? pt() : lastCtrl && /[CcSs]/.test(lastCmd) ? [2 * p[0] - lastCtrl[0], 2 * p[1] - lastCtrl[1]] : p;
          const c2 = pt();
          const e = pt();
          const len = Math.hypot(c1[0] - p[0], c1[1] - p[1]) + Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) + Math.hypot(e[0] - c2[0], e[1] - c2[1]);
          const n = pieces(m, len);
          const pts: Point2[] = [];
          for (let k = 0; k <= n; k++) {
            const t = k / n;
            const u = 1 - t;
            pts.push([u ** 3 * p[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * e[0], u ** 3 * p[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * e[1]]);
          }
          pts[n] = e;
          emitPolyline(m, pts);
          lastCtrl = c2;
          p = e;
        } else if (C === 'Q' || C === 'T') {
          const c1: Point2 = C === 'Q' ? pt() : lastCtrl && /[QqTt]/.test(lastCmd) ? [2 * p[0] - lastCtrl[0], 2 * p[1] - lastCtrl[1]] : p;
          const e = pt();
          const n = pieces(m, Math.hypot(c1[0] - p[0], c1[1] - p[1]) + Math.hypot(e[0] - c1[0], e[1] - c1[1]));
          const pts: Point2[] = [];
          for (let k = 0; k <= n; k++) {
            const t = k / n;
            const u = 1 - t;
            pts.push([u * u * p[0] + 2 * u * t * c1[0] + t * t * e[0], u * u * p[1] + 2 * u * t * c1[1] + t * t * e[1]]);
          }
          pts[n] = e;
          emitPolyline(m, pts);
          lastCtrl = c1;
          p = e;
        } else if (C === 'A') {
          const rx = num();
          const ry = num();
          const rot = num();
          const large = flag();
          const sw = flag();
          const e = pt();
          arc(m, p, rx, ry, rot, large, sw, e);
          p = e;
          lastCtrl = null;
        } else throw new Error(`SVG 경로 명령 ${cmd} 를 읽지 못했습니다`);
        lastCmd = cmd;
      } while (more());
      lastCmd = cmd;
    }
  };

  const ellipse = (m: Mat, cx: number, cy: number, rx: number, ry: number) => {
    if (rx <= 0 || ry <= 0) return;
    const sim = similarity(m);
    if (sim !== null) {
      const c = apply(m, [cx, cy]);
      if (Math.abs(rx - ry) < 1e-12) return void circles.push({ c, r: rx * sim });
      // 회전 각: x 축이 변환된 방향 (뒤집기 포함)
      const ang = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
      return void ellipses.push({ c, w: 2 * rx * sim, h: 2 * ry * sim, angle: Math.round(ang * 1e6) / 1e6 + 0 });
    }
    const n = 48;
    const pts = Array.from({ length: n + 1 }, (_, k) => [cx + rx * Math.cos((2 * Math.PI * k) / n), cy + ry * Math.sin((2 * Math.PI * k) / n)] as Point2);
    emitPolyline(m, pts);
  };

  for (const t of src.matchAll(/<(\/?)([a-zA-Z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g)) {
    const [, close, rawTag, rawAttrs, self] = t;
    const tag = rawTag!.replace(/^svg:/, '');
    if (close) {
      if (stack.length && cur().tag === tag) stack.pop();
      continue;
    }
    const a = attrsOf(rawAttrs ?? '');
    const parent = cur();
    let m = mul(parent.m, parseTransform(a.transform));
    const hidden = a.display === 'none' || /display\s*:\s*none/.test(a.style ?? '');
    const skip = parent.skip || SKIP.has(tag) || hidden;
    if (tag === 'svg' && !stack.length) {
      // 바깥 svg: viewBox·크기 → mm, 그리고 y 뒤집기
      const vb = nums(a.viewBox);
      const wMm = lengthMm(a.width);
      const unit = a.width?.trim().match(/(mm|cm|in|pt|pc|px)$/)?.[1] ?? 'px';
      unitLabel = unit;
      let s = 25.4 / 96;
      let [vx, vy] = [0, 0];
      if (vb.length === 4 && vb[2]! > 0) {
        [vx, vy] = [vb[0]!, vb[1]!];
        if (wMm) s = wMm / vb[2]!;
      }
      m = [s, 0, 0, -s, -s * vx, s * vy];
    }
    if (!self) stack.push({ m, skip, tag });
    if (skip) continue;
    const n = (k: string, d = 0) => {
      const v = Number.parseFloat(a[k] ?? '');
      return Number.isFinite(v) ? v : d;
    };
    if (tag === 'path') path(m, a.d ?? '');
    else if (tag === 'line') emitLine(m, [n('x1'), n('y1')], [n('x2'), n('y2')]);
    else if (tag === 'polyline' || tag === 'polygon') {
      const v = nums(a.points);
      const pts: Point2[] = [];
      for (let k = 0; k + 1 < v.length; k += 2) pts.push([v[k]!, v[k + 1]!]);
      if (tag === 'polygon' && pts.length > 2) pts.push(pts[0]!);
      emitPolyline(m, pts);
    } else if (tag === 'rect') {
      const [x, y, w, h] = [n('x'), n('y'), n('width'), n('height')];
      if (w <= 0 || h <= 0) continue;
      let rx = a.rx !== undefined ? n('rx') : a.ry !== undefined ? n('ry') : 0;
      let ry = a.ry !== undefined ? n('ry') : rx;
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (rx > 0 && ry > 0)
        path(m, `M${x + rx},${y} H${x + w - rx} A${rx},${ry} 0 0 1 ${x + w},${y + ry} V${y + h - ry} A${rx},${ry} 0 0 1 ${x + w - rx},${y + h} H${x + rx} A${rx},${ry} 0 0 1 ${x},${y + h - ry} V${y + ry} A${rx},${ry} 0 0 1 ${x + rx},${y} Z`);
      else emitPolyline(m, [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]);
    } else if (tag === 'circle') ellipse(m, n('cx'), n('cy'), n('r'), n('r'));
    else if (tag === 'ellipse') ellipse(m, n('cx'), n('cy'), n('rx'), n('ry'));
    else if (tag === 'image' || tag === 'use' || tag === 'foreignObject') skipped[tag] = (skipped[tag] ?? 0) + 1;
  }
  if (src.includes('<text')) skipped.text = (src.match(/<text[\s>]/g) ?? []).length;
  return { segs, circles, ellipses, skipped, scale: 1, unitLabel };
}
