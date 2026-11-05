/**
 * 스케치 구속 UI (docs/review-constraint-solver.md 1단계).
 * - 다각형: 꼭짓점 좌표(점 이동 → 해석기가 나머지를 맞춤), 변마다 수평·수직·길이, 꼭짓점 고정
 * - 구속 목록: 값 수정·삭제, 두 대상 구속 추가(평행·직교·같은 길이·일치·거리·동심·접선)
 * - 자유도 표시: 0 이면 완전 구속
 * 모든 편집은 명령(submitNow) → 실행기가 해석기를 돌리고, 풀 수 없으면 거부(상태바에 이유).
 */
import { useMemo, useState } from 'react';
import type { ConstraintType, Point2, Sketch, SketchEntity } from '../../cad/commandTypes';
import { useSceneStore } from '../../cad/sceneStore';
import { planeAxes } from '../../cad/sketchPlane';
import { CONSTRAINT_ARITY, CONSTRAINT_LABEL, degreesOfFreedom, refKind, sketchPoints } from '../../cad/solver';
import { formatMm } from '../../cad/units';
import { NumberField } from './NumberField';

type Polygon = Extract<SketchEntity, { type: 'polygon' | 'path' }>;

const isFixed = (sketch: Sketch, ref: string) => sketch.constraints.some((c) => c.type === 'fix' && c.refs[0] === ref);

/** 다각형 꼭짓점·변 편집 */
export function PolygonFields({ sketch, polygon }: { sketch: Sketch; polygon: Polygon }) {
  const submitNow = useSceneStore((s) => s.submitNow);
  const [ax, ay] = planeAxes(sketch.plane);
  const add = (constraint: ConstraintType, refs: string[], value?: number) =>
    submitNow({ type: 'add_constraint', sketch: sketch.id, constraint, refs, ...(value !== undefined ? { value } : {}) });
  const n = polygon.points.length;
  return (
    <>
      <div className="muted small">꼭짓점 (값을 바꾸면 구속을 지키며 나머지가 따라옵니다)</div>
      {polygon.points.map((p, k) => {
        const ref = `${polygon.id}.p${k}`;
        const move = (axis: 0 | 1) => (v: number) => {
          const to: Point2 = [...p];
          to[axis] = v;
          submitNow({ type: 'move_point', sketch: sketch.id, point: ref, to });
        };
        const fixed = isFixed(sketch, ref);
        return (
          <div key={ref} className="vertex-row" data-testid={`vertex-${ref}`}>
            <div className="vertex-head">
              <strong>p{k}</strong>
              <button
              aria-pressed={fixed}
              data-testid={`fix-${ref}`}
              title={fixed ? '고정 해제는 아래 구속 목록에서 삭제' : '이 점을 현재 위치에 고정'}
              disabled={fixed}
              onClick={() => add('fix', [ref])}
            >
              {fixed ? '고정됨' : '고정'}
              </button>
            </div>
            <NumberField label={ax} unit="mm" value={p[0]} onCommit={move(0)} testId={`pt-${ref}-x`} />
            <NumberField label={ay} unit="mm" value={p[1]} onCommit={move(1)} testId={`pt-${ref}-y`} />
          </div>
        );
      })}
      <div className="muted small">변</div>
      {(polygon.type === 'path' ? polygon.points.slice(0, -1) : polygon.points).map((a, k) => {
        const b = polygon.points[(k + 1) % n]!;
        const ref = `${polygon.id}.e${k}`;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        return (
          <div key={ref} className="edge-row">
            <span>
              e{k} <span className="muted">{formatMm(len)}mm</span>
            </span>
            <button data-testid={`h-${ref}`} onClick={() => add('horizontal', [ref])} title="수평 (u 축과 나란히)">
              ─
            </button>
            <button data-testid={`v-${ref}`} onClick={() => add('vertical', [ref])} title="수직 (v 축과 나란히)">
              │
            </button>
            <button data-testid={`len-${ref}`} onClick={() => add('length', [ref], Math.round(len * 100) / 100 || 1)} title="지금 길이로 길이 구속">
              길이
            </button>
            {!polygon.spline && <input
              className="bulge-input"
              aria-label={`e${k} 호 볼록 정도`}
              title="변을 호로: 볼록 정도 (0 = 직선, ±1 = 반원, 부호 = 방향)"
              data-testid={`bulge-${ref}`}
              type="number"
              step={0.1}
              min={-1}
              max={1}
              defaultValue={polygon.arcs?.find((x) => x.k === k)?.bulge ?? 0}
              key={`${ref}:${polygon.arcs?.find((x) => x.k === k)?.bulge ?? 0}`}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                const v = Number((e.target as HTMLInputElement).value);
                if (Number.isFinite(v)) submitNow({ type: 'set_arc', sketch: sketch.id, entity: polygon.id, edge: k, bulge: Math.max(-1, Math.min(1, v)) });
              }}
            />}
          </div>
        );
      })}
      <label className="check" title="점들을 지나는 매끈한 곡선 (켜면 꼭짓점 처리·호 변은 지워집니다)">
        <input
          type="checkbox"
          checked={!!polygon.spline}
          onChange={(e) => submitNow({ type: 'set_spline', sketch: sketch.id, entity: polygon.id, spline: e.target.checked })}
          data-testid={`spline-${polygon.id}`}
        />
        스플라인 (점을 지나는 매끈한 곡선)
      </label>
      {!polygon.spline && <CornerFields sketch={sketch} entity={polygon} />}
    </>
  );
}

/**
 * 스케치 필렛·모따기 (형식 v10): 고른 꼭짓점(안 고르면 모든 꼭짓점, 경로는 안쪽 꼭짓점)에 같은 크기로. 크기 0 = 제거.
 * 호 변(v13)에 붙은 꼭짓점은 처리할 수 없다
 */
function CornerFields({ sketch, entity }: { sketch: Sketch; entity: Polygon }) {
  const submitNow = useSceneStore((s) => s.submitNow);
  const first = entity.corners?.[0];
  const [corner, setCorner] = useState<'fillet' | 'chamfer'>(first?.type ?? 'fillet');
  const n = entity.points.length;
  const candidates = Array.from({ length: n }, (_, k) => k).filter((k) => entity.type === 'polygon' || (k > 0 && k < n - 1));
  // 꼭짓점 고르기: 비우면 모든 꼭짓점
  const [only, setOnly] = useState<number[]>([]);
  const apply = (size: number) =>
    submitNow({ type: 'set_corner', sketch: sketch.id, entity: entity.id, corner, size, ...(only.length ? { vertices: only } : {}) });
  return (
    <fieldset className="corner-fields">
      <legend>꼭짓점 처리 (스케치 필렛·모따기)</legend>
      <div className="field">
        <label htmlFor={`corner-type-${entity.id}`}>종류</label>
        <select id={`corner-type-${entity.id}`} data-testid="corner-type" value={corner} onChange={(e) => setCorner(e.target.value as 'fillet' | 'chamfer')}>
          <option value="fillet">필렛 (둥글게)</option>
          <option value="chamfer">모따기 (비스듬히)</option>
        </select>
      </div>
      <div className="corner-vertices" role="group" aria-label="처리할 꼭짓점">
        {candidates.map((k) => (
          <label key={k} className="check small">
            <input
              type="checkbox"
              data-testid={`corner-v${k}`}
              checked={only.includes(k)}
              onChange={(e) => setOnly((o) => (e.target.checked ? [...o, k].sort((x, y) => x - y) : o.filter((x) => x !== k)))}
            />
            p{k}
          </label>
        ))}
        <span className="muted small">{only.length ? '고른 꼭짓점만' : '안 고르면 모든 꼭짓점'}</span>
      </div>
      <NumberField label={corner === 'fillet' ? '반지름' : '거리'} unit="mm" value={first?.size ?? 0} onCommit={apply} testId="corner-size" />
      <p className="muted small">
        {entity.corners?.length ? `처리된 꼭짓점: ${entity.corners.map((c) => `p${c.k}`).join(', ')}` : '0 = 처리 없음'}
        {entity.type === 'path' ? ' · 경로는 양 끝점을 뺀 꺾이는 점에만' : ''}
      </p>
    </fieldset>
  );
}

/** 구속 목록 + 두 대상 구속 추가 + 자유도 */
export function ConstraintPanel({ sketch }: { sketch: Sketch }) {
  const submitNow = useSceneStore((s) => s.submitNow);
  const dof = useMemo(() => degreesOfFreedom(sketch), [sketch]);
  const hasPoints = sketchPoints(sketch).size > 0;
  if (!hasPoints) return null;
  return (
    <fieldset>
      <legend>구속</legend>
      <div className="muted small" data-testid="sketch-dof">
        자유도 {dof}
        {dof === 0 ? ' · 완전 구속' : ' · 더 구속할 수 있습니다'}
      </div>
      {sketch.constraints.length === 0 && <div className="muted small">구속이 없습니다</div>}
      <ul className="constraint-list">
        {sketch.constraints.map((c) => (
          <li key={c.id} data-testid={`constraint-${c.id}`}>
            <span>
              {CONSTRAINT_LABEL[c.type]} <span className="muted">{c.refs.join(' · ')}</span>
            </span>
            {c.value !== undefined && (
              <NumberField
                label={c.id}
                unit={c.type === 'angle' ? '°' : 'mm'}
                value={c.value}
                onCommit={(v) => submitNow({ type: 'set_constraint', sketch: sketch.id, constraint: c.id, value: v })}
                testId={`cval-${c.id}`}
              />
            )}
            <button
              className="danger"
              data-testid={`cdel-${c.id}`}
              onClick={() => submitNow({ type: 'delete_constraint', sketch: sketch.id, constraint: c.id })}
            >
              삭제
            </button>
          </li>
        ))}
      </ul>
      <PairConstraintForm sketch={sketch} />
    </fieldset>
  );
}

const PAIR_TYPES: ConstraintType[] = ['parallel', 'perpendicular', 'angle', 'equal', 'coincident', 'distance', 'concentric', 'tangent', 'symmetric', 'midpoint'];

function PairConstraintForm({ sketch }: { sketch: Sketch }) {
  const submitNow = useSceneStore((s) => s.submitNow);
  const [type, setType] = useState<ConstraintType>('parallel');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [c3, setC3] = useState('');
  const [value, setValue] = useState(10);
  // 이 구속에 맞는 참조 후보 (첫 번째·두 번째 자리)
  const all = useMemo(() => {
    const refs: string[] = [...sketchPoints(sketch).keys()];
    for (const e of sketch.entities) {
      if (e.type === 'polygon') e.points.forEach((_, k) => refs.push(`${e.id}.e${k}`));
      if (e.type === 'path') e.points.slice(1).forEach((_, k) => refs.push(`${e.id}.e${k}`));
      if (e.type === 'line') refs.push(`${e.id}.e0`);
      if (e.type === 'circle') refs.push(e.id);
      // 사각형 모서리·변 (형식 v21): 왼쪽 아래부터 반시계
      if (e.type === 'rectangle') for (let k = 0; k < 4; k++) refs.push(`${e.id}.p${k}`, `${e.id}.e${k}`);
    }
    return refs;
  }, [sketch]);
  const form = CONSTRAINT_ARITY[type].refs.find((f) => f.length >= 2)!;
  const third = form.length === 3 ? all.filter((r) => refKind(sketch, r) === form[2]) : [];
  const rc = third.includes(c3) ? c3 : (third[0] ?? '');
  const first = all.filter((r) => refKind(sketch, r) === form[0]);
  const second = all.filter((r) => refKind(sketch, r) === form[1]);
  const ra = first.includes(a) ? a : (first[0] ?? '');
  const rb = second.includes(b) && b !== ra ? b : (second.find((r) => r !== ra) ?? '');
  const needsValue = CONSTRAINT_ARITY[type].value;
  return (
    <div className="pair-constraint">
      <div className="field">
        <label htmlFor="pair-type">두 대상</label>
        <select id="pair-type" data-testid="pair-type" value={type} onChange={(e) => setType(e.target.value as ConstraintType)}>
          {PAIR_TYPES.map((t) => (
            <option key={t} value={t}>
              {CONSTRAINT_LABEL[t]}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <select aria-label="첫 번째 대상" data-testid="pair-a" value={ra} onChange={(e) => setA(e.target.value)}>
          {first.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select aria-label="두 번째 대상" data-testid="pair-b" value={rb} onChange={(e) => setB(e.target.value)}>
          {second.filter((r) => r !== ra).map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        {form.length === 3 && (
          <select aria-label="대칭축" title="대칭축 (구성선·변)" data-testid="pair-c" value={rc} onChange={(e) => setC3(e.target.value)}>
            {third.map((r) => (
              <option key={r} value={r}>
                축 {r}
              </option>
            ))}
          </select>
        )}
      </div>
      {needsValue && <NumberField label={type === 'angle' ? '각도' : '거리'} unit={type === 'angle' ? '°' : 'mm'} value={value} onCommit={setValue} testId="pair-value" />}
      <button
        data-testid="pair-add"
        disabled={!ra || !rb || (form.length === 3 && !rc)}
        onClick={() =>
          submitNow({ type: 'add_constraint', sketch: sketch.id, constraint: type, refs: form.length === 3 ? [ra, rb, rc] : [ra, rb], ...(needsValue ? { value } : {}) })
        }
      >
        구속 추가
      </button>
    </div>
  );
}
