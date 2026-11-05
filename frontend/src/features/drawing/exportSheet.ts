/**
 * 도면 시트 → 파일 (로컬에서 만든다, 의존성 없음).
 * - SVG: 용지 크기(mm) 그대로. 글꼴은 시스템 글꼴(원격 글꼴 없음).
 * - DXF: R12(AC1009) — 거의 모든 CAD 가 읽는다. 층 VISIBLE·HIDDEN(파선)·DIM·FRAME·TEXT, 한글은 \U+XXXX.
 */
import type { Layer, Sheet } from './sheet';

const STROKE: Record<Layer, { w: number; color: string; dash?: string }> = {
  visible: { w: 0.5, color: '#000' },
  hidden: { w: 0.25, color: '#000', dash: '2.5 1.2' },
  dim: { w: 0.18, color: '#000' },
  frame: { w: 0.5, color: '#000' },
  text: { w: 0.18, color: '#000' },
};

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => String(Math.round(v * 1000) / 1000);

export function sheetToSvg(sheet: Sheet): string {
  const H = sheet.height;
  const pts = (p: number[]) => p.flatMap((_, k) => (k % 2 ? [] : [`${n(p[k]!)},${n(H - p[k + 1]!)}`])).join(' ');
  const body = sheet.items
    .map((it) => {
      if (it.kind === 'line') {
        const s = STROKE[it.layer];
        return `<polyline class="${it.layer}" points="${pts(it.points)}" fill="none" stroke="${s.color}" stroke-width="${s.w}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''} stroke-linecap="round" stroke-linejoin="round"/>`;
      }
      if (it.kind === 'fill') return `<polygon points="${pts(it.points)}" fill="#000"/>`;
      const x = n(it.x);
      const y = n(H - it.y);
      const rot = it.angle ? ` transform="rotate(${-it.angle} ${x} ${y})"` : '';
      return `<text x="${x}" y="${y}" font-size="${it.size}" text-anchor="${it.anchor}"${rot}>${esc(it.text)}</text>`;
    })
    .join('\n');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.width}mm" height="${sheet.height}mm" viewBox="0 0 ${sheet.width} ${sheet.height}">`,
    `<rect width="${sheet.width}" height="${sheet.height}" fill="#fff"/>`,
    `<g font-family="'Malgun Gothic','Apple SD Gothic Neo','Noto Sans CJK KR','Noto Sans KR',sans-serif" fill="#000">`,
    body,
    '</g>',
    '</svg>',
    '',
  ].join('\n');
}

/** DXF 글자: ASCII 밖은 \U+XXXX (R12 에서 한글을 잃지 않는 방법) */
export const dxfText = (t: string) =>
  [...t].map((ch) => (ch.codePointAt(0)! < 128 ? ch : `\\U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`)).join('');

const LAYERS: Record<Layer, { name: string; color: number; ltype: string }> = {
  visible: { name: 'VISIBLE', color: 7, ltype: 'CONTINUOUS' },
  hidden: { name: 'HIDDEN', color: 8, ltype: 'HIDDEN' },
  dim: { name: 'DIM', color: 3, ltype: 'CONTINUOUS' },
  frame: { name: 'FRAME', color: 7, ltype: 'CONTINUOUS' },
  text: { name: 'TEXT', color: 7, ltype: 'CONTINUOUS' },
};

export function sheetToDxf(sheet: Sheet): string {
  const out: (string | number)[] = [];
  const g = (code: number, v: string | number) => out.push(code, typeof v === 'number' ? n(v) : v);
  g(0, 'SECTION');
  g(2, 'HEADER');
  g(9, '$ACADVER');
  g(1, 'AC1009');
  g(9, '$INSUNITS');
  g(70, '4'); // mm
  g(9, '$EXTMIN');
  g(10, 0);
  g(20, 0);
  g(9, '$EXTMAX');
  g(10, sheet.width);
  g(20, sheet.height);
  g(0, 'ENDSEC');
  g(0, 'SECTION');
  g(2, 'TABLES');
  g(0, 'TABLE');
  g(2, 'LTYPE');
  g(70, '2');
  g(0, 'LTYPE');
  g(2, 'CONTINUOUS');
  g(70, '0');
  g(3, 'Solid line');
  g(72, '65');
  g(73, '0');
  g(40, 0);
  g(0, 'LTYPE');
  g(2, 'HIDDEN');
  g(70, '0');
  g(3, 'Hidden __ __ __');
  g(72, '65');
  g(73, '2');
  g(40, 3.7);
  g(49, 2.5);
  g(49, -1.2);
  g(0, 'ENDTAB');
  g(0, 'TABLE');
  g(2, 'LAYER');
  g(70, String(Object.keys(LAYERS).length));
  for (const l of Object.values(LAYERS)) {
    g(0, 'LAYER');
    g(2, l.name);
    g(70, '0');
    g(62, String(l.color));
    g(6, l.ltype);
  }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');
  g(0, 'SECTION');
  g(2, 'ENTITIES');
  for (const it of sheet.items) {
    const layer = LAYERS[it.layer].name;
    if (it.kind === 'line') {
      for (let k = 2; k + 1 < it.points.length; k += 2) {
        g(0, 'LINE');
        g(8, layer);
        g(10, it.points[k - 2]!);
        g(20, it.points[k - 1]!);
        g(30, 0);
        g(11, it.points[k]!);
        g(21, it.points[k + 1]!);
        g(31, 0);
      }
    } else if (it.kind === 'fill') {
      // 삼각형 화살표: SOLID (꼭짓점 3개 → 넷째 = 셋째)
      const p = it.points;
      g(0, 'SOLID');
      g(8, layer);
      for (const [k, code] of [[0, 10], [1, 11], [2, 12], [2, 13]] as const) {
        g(code, p[k * 2]!);
        g(code + 10, p[k * 2 + 1]!);
        g(code + 20, 0);
      }
    } else {
      g(0, 'TEXT');
      g(8, layer);
      g(10, it.x);
      g(20, it.y);
      g(30, 0);
      g(40, it.size);
      g(1, dxfText(it.text));
      if (it.angle) g(50, it.angle);
      if (it.anchor !== 'start') {
        g(72, it.anchor === 'middle' ? '1' : '2');
        g(11, it.x);
        g(21, it.y);
        g(31, 0);
      }
    }
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  const lines: string[] = [];
  for (let k = 0; k < out.length; k += 2) lines.push(String(out[k]).padStart(3, ' '), String(out[k + 1]));
  return lines.join('\r\n') + '\r\n';
}
