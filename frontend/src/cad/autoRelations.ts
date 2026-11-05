/**
 * 자동 구속 (솔리드웍스 "자동 관계"): 그릴 때 붙은 점·정렬 안내를 구속으로 남긴다 — 순수 함수.
 * - 다른 요소의 점(꼭짓점·중심)에 붙음 → 일치, 원점에 붙음 → 고정
 * - 다른 점과 수평·수직 정렬 안내 → 두 점 수평/수직
 * - 그린 변이 정확히 가로·세로 → 변 수평/수직, 숫자로 입력한 길이 → 길이 구속
 * 넣을 수 없는(모순·과다) 구속은 하나씩 확인해 건너뛴다 → 그리기 자체는 항상 된다.
 */
import type { CadCommand, ConstraintType, ModelDefinition, ObjectId, Point2 } from './commandTypes';
import { executeBatch } from './commandExecutor';
import type { SnapResult } from './sketchSnap';

export interface Relation {
  constraint: ConstraintType;
  refs: string[];
  value?: number;
}
/** 찍은 점 하나의 정보: 어디에 붙었는지, 숫자로 친 길이(앞 점에서) */
export interface PlacedMeta {
  snap?: Pick<SnapResult, 'kind' | 'ref' | 'guides'>;
  length?: number;
}

const EPS = 1e-9;
const key = (r: Relation) => `${r.constraint}:${r.refs.join(',')}`;

/** 한 점(이름 self)이 붙은 정보 → 구속. selfIndex·adjacent: 그리는 중인 다른 점(@번호) 처리 */
function pointRelations(self: string, snap: PlacedMeta['snap'], resolve: (ref: string) => string | null): Relation[] {
  if (!snap) return [];
  if (snap.kind === 'origin') return [{ constraint: 'fix', refs: [self] }];
  if (snap.ref) {
    const other = resolve(snap.ref);
    return other ? [{ constraint: 'coincident', refs: [self, other] }] : [];
  }
  const out: Relation[] = [];
  for (const g of snap.guides) {
    if (g.dir === 'angle' || !g.ref) continue;
    const other = resolve(g.ref);
    if (other) out.push({ constraint: g.dir === 'h' ? 'horizontal' : 'vertical', refs: [self, other] });
  }
  return out;
}

/** 다각형·경로·호(경로 2점) 구속. straight = 변이 직선(스플라인·호가 아님) */
export function polylineRelations(id: ObjectId, points: Point2[], meta: PlacedMeta[], o: { closed: boolean; straight: boolean }): Relation[] {
  const n = points.length;
  const p = (i: number) => `${id}.p${i}`;
  const adjacent = (i: number, j: number) => Math.abs(i - j) === 1 || (o.closed && ((i === 0 && j === n - 1) || (j === 0 && i === n - 1)));
  const out: Relation[] = [];
  meta.forEach((m, i) => {
    out.push(
      ...pointRelations(p(i), m.snap, (ref) => {
        if (!ref.startsWith('@')) return ref;
        const j = Number(ref.slice(1));
        // 같은 도형의 다른 점: 이웃 점과의 정렬은 변 구속이 맡고, 같은 점에 붙는 일치는 만들지 않는다
        return j === i || adjacent(i, j) || m.snap?.ref === ref ? null : p(j);
      }),
    );
  });
  if (o.straight) {
    const edges = o.closed ? n : n - 1;
    for (let k = 0; k < edges; k++) {
      const a = points[k]!;
      const b = points[(k + 1) % n]!;
      const e = `${id}.e${k}`;
      if (Math.abs(a[1] - b[1]) < EPS && Math.abs(a[0] - b[0]) > EPS) out.push({ constraint: 'horizontal', refs: [e] });
      else if (Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) > EPS) out.push({ constraint: 'vertical', refs: [e] });
      const typed = k + 1 < n ? meta[k + 1]?.length : undefined;
      if (typed !== undefined) out.push({ constraint: 'length', refs: [e], value: typed });
    }
  }
  return dedupe(out);
}

/** 중심이 있는 도형(원): 중심이 붙은 점·정렬 → 구속 */
export function centerRelations(id: ObjectId, snap: PlacedMeta['snap']): Relation[] {
  return dedupe(pointRelations(`${id}.center`, snap, (ref) => (ref.startsWith('@') ? null : ref)));
}

function dedupe(rs: Relation[]): Relation[] {
  const seen = new Set<string>();
  return rs.filter((r) => !seen.has(key(r)) && seen.add(key(r)));
}

/**
 * 그리기 명령 묶음 뒤에 구속을 붙인다. 하나씩 실제로 실행해 보고 되는 것만 (모순·이미 정의됨은 건너뜀).
 * 돌려주는 added = 넣은 구속 수
 */
export function withRelations(model: ModelDefinition, base: CadCommand[], sketch: ObjectId, rels: Relation[]): { commands: CadCommand[]; added: number } {
  if (!rels.length || !executeBatch(model, base).ok) return { commands: base, added: 0 };
  let commands = base;
  let added = 0;
  for (const r of rels) {
    const c: CadCommand = { type: 'add_constraint', sketch, constraint: r.constraint, refs: r.refs, ...(r.value !== undefined ? { value: r.value } : {}) };
    if (executeBatch(model, [...commands, c]).ok) {
      commands = [...commands, c];
      added++;
    }
  }
  return { commands, added };
}

/** 그리기 명령 묶음에서 대상 스케치 ID·새 요소 ID */
export function drawnTarget(cmds: CadCommand[]): { sketch: ObjectId; entity: ObjectId } | null {
  for (const c of cmds) {
    if ('sketch' in c && 'id' in c && typeof c.id === 'string' && c.type.startsWith('add_')) return { sketch: c.sketch as ObjectId, entity: c.id };
  }
  return null;
}
