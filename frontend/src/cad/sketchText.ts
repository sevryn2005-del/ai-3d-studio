/**
 * 스케치 텍스트 (솔리드웍스 "스케치 텍스트"·블렌더 텍스트 → 메시): 글자를 글꼴 윤곽으로 바꿔
 * 보통의 스케치 요소로 넣는다 — 닫힌 다각형 + 그 다각형들을 합치고 빼는 영역 하나 (돌출·컷·각인).
 * 저장 형식은 그대로 (글자는 다시 고칠 수 없는 윤곽이 된다 — 다시 쓰려면 지우고 새로 넣기).
 *
 * 글꼴 의존성은 getPath 하나뿐 (opentype.js Font 와 같은 모양) — 이 파일은 순수 함수라 단위 시험이 쉽다.
 */
import type { CadCommand, ObjectId, Point2 } from './commandTypes';
import { LIMITS, MAX_REGION_ITEMS } from './commandTypes';
import { simplifyToLimit } from './simplify';

export interface PathCommand {
  type: 'M' | 'L' | 'Q' | 'C' | 'Z';
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}
export interface GlyphSource {
  getPath(text: string, x: number, y: number, fontSize: number): { commands: PathCommand[] };
  /** 글자가 글꼴에 있는지 (없으면 빈 칸으로 그려진다) */
  hasChar?(ch: string): boolean;
}
export interface TextOptions {
  text: string;
  /** 글자 크기 (em, mm) — 한글 한 글자 높이 ≈ 0.9배 */
  size: number;
  /** 글자 덩어리 가운데가 올 스케치 좌표 */
  center: Point2;
  /** 줄 간격 (글자 크기 배수) */
  lineHeight?: number;
}

export function signedArea(pts: Point2[]): number {
  let a = 0;
  pts.forEach((p, k) => {
    const q = pts[(k + 1) % pts.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  });
  return a / 2;
}

function inside(p: Point2, poly: Point2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/**
 * 글자 → 닫힌 윤곽 (스케치 좌표 mm, 위 = +v). 곡선은 크기에 맞춰 나누고 단순화해 윤곽마다 점 64개 이하.
 */
export function textContours(font: GlyphSource, o: TextOptions): Point2[][] {
  const lines = o.text.split('\n');
  const lh = (o.lineHeight ?? 1.25) * o.size;
  const raw: Point2[][] = [];
  lines.forEach((line, li) => {
    const path = font.getPath(line, 0, li * lh, o.size);
    let cur: Point2[] = [];
    let last: Point2 = [0, 0];
    const flush = () => {
      if (cur.length >= 3) raw.push(cur);
      cur = [];
    };
    const steps = (len: number) => Math.max(2, Math.min(10, Math.ceil(len / (o.size * 0.04))));
    for (const c of path.commands) {
      // 화면 좌표(y 아래) → 스케치 좌표(v 위)
      const P = (x = 0, y = 0): Point2 => [x, -y];
      if (c.type === 'M') {
        flush();
        last = P(c.x, c.y);
        cur.push(last);
      } else if (c.type === 'L') {
        last = P(c.x, c.y);
        cur.push(last);
      } else if (c.type === 'Q') {
        const p0 = last;
        const p1 = P(c.x1, c.y1);
        const p2 = P(c.x, c.y);
        const n = steps(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]));
        for (let k = 1; k <= n; k++) {
          const t = k / n;
          const u = 1 - t;
          cur.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
        }
        last = p2;
      } else if (c.type === 'C') {
        const p0 = last;
        const p1 = P(c.x1, c.y1);
        const p2 = P(c.x2, c.y2);
        const p3 = P(c.x, c.y);
        const n = steps(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]));
        for (let k = 1; k <= n; k++) {
          const t = k / n;
          const u = 1 - t;
          const b = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t] as const;
          cur.push([b[0] * p0[0] + b[1] * p1[0] + b[2] * p2[0] + b[3] * p3[0], b[0] * p0[1] + b[1] * p1[1] + b[2] * p2[1] + b[3] * p3[1]]);
        }
        last = p3;
      } else if (c.type === 'Z') flush();
    }
    flush();
  });
  // 겹친 점(닫는 점 포함) 지우기 → 단순화 (점 64개 이하가 될 때까지 허용 오차를 늘림)
  const eps = o.size * 1e-4;
  const cleaned = raw
    .map((pts) => {
      const out: Point2[] = [];
      for (const p of pts) if (!out.length || Math.hypot(p[0] - out[out.length - 1]![0], p[1] - out[out.length - 1]![1]) > eps) out.push(p);
      while (out.length > 1 && Math.hypot(out[0]![0] - out[out.length - 1]![0], out[0]![1] - out[out.length - 1]![1]) <= eps) out.pop();
      return simplifyToLimit(out, LIMITS.maxPolygonPoints, o.size * 0.002);
    })
    .filter((pts) => pts.length >= 3 && Math.abs(signedArea(pts)) > o.size * o.size * 1e-5);
  if (!cleaned.length) return [];
  // 가운데 맞춤
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const pts of cleaned)
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  const dx = o.center[0] - (x0 + x1) / 2;
  const dy = o.center[1] - (y0 + y1) / 2;
  return cleaned.map((pts) => pts.map(([x, y]) => [Math.round((x + dx) * 1e4) / 1e4 + 0, Math.round((y + dy) * 1e4) / 1e4 + 0] as Point2));
}

/** 글꼴에 없는 글자 (공백·줄바꿈 제외) */
export function missingChars(font: GlyphSource, text: string): string[] {
  if (!font.hasChar) return [];
  return [...new Set([...text].filter((ch) => !/\s/.test(ch) && !font.hasChar!(ch)))];
}

export interface TextCommandsResult {
  commands: CadCommand[];
  regionId: ObjectId | null;
  contours: number;
  warnings: string[];
}

/**
 * 윤곽 → 스케치 명령: 다각형(반시계로 맞춤) 여러 개 + 영역 하나.
 * 영역 순서는 넓이 큰 것부터, 합치기/빼기는 윤곽 방향으로 (가장 큰 윤곽과 같은 방향 = 바깥 = 합치기, 반대 = 구멍 = 빼기)
 * — 겹친 획(가변 글꼴에서 흔함)은 합쳐지고, 'ㅇ'·'A' 의 속은 빠지고, 구멍 속 섬은 다시 합쳐진다.
 */
export function textSketchCommands(contours: Point2[][], sketch: ObjectId, taken: Set<string>, room: number = LIMITS.maxSketchEntities): TextCommandsResult {
  const warnings: string[] = [];
  const newId = (prefix: string) => {
    let n = 1;
    while (taken.has(`${prefix}${n}`)) n++;
    taken.add(`${prefix}${n}`);
    return `${prefix}${n}`;
  };
  if (!contours.length) return { commands: [], regionId: null, contours: 0, warnings: ['그릴 윤곽이 없습니다'] };
  const max = Math.min(room - 1, MAX_REGION_ITEMS);
  let list = contours.map((pts) => ({ pts, area: signedArea(pts) }));
  if (list.length > max) {
    warnings.push(`글자 윤곽이 ${list.length}개라 한 스케치에 넣을 수 있는 ${Math.max(0, max)}개를 넘습니다 — 글자를 나눠 여러 스케치에 넣으세요`);
    return { commands: [], regionId: null, contours: 0, warnings };
  }
  list = list.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
  const outerSign = Math.sign(list[0]!.area);
  // 같은 방향이라도 더 큰 다른 방향 윤곽 안에 있으면(섬) 합치기 — 방향만으로 충분하지만 첫 항목은 반드시 합치기
  const items: { entity: string; op: 'add' | 'subtract' }[] = [];
  const commands: CadCommand[] = [];
  for (const c of list) {
    const id = newId('text');
    const pts = c.area < 0 ? [...c.pts].reverse() : c.pts;
    commands.push({ type: 'add_polygon', sketch, id, points: pts });
    let op: 'add' | 'subtract' = Math.sign(c.area) === outerSign ? 'add' : 'subtract';
    // 아무 합치기 윤곽에도 들지 않는 구멍은 무시하지 말고 합치기로 (방향이 거꾸로 된 글꼴)
    if (op === 'subtract' && !items.some((it, k) => it.op === 'add' && inside(c.pts[0]!, list[k]!.pts))) op = 'add';
    items.push({ entity: id, op });
  }
  const regionId = newId('text_region');
  commands.push({ type: 'add_region', sketch, id: regionId, items });
  return { commands, regionId, contours: list.length, warnings };
}
