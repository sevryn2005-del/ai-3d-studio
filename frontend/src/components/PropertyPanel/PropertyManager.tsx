/**
 * 속성 관리자 (솔리드웍스식): 피처를 확정하기 전에 값을 고르고 뷰포트 미리보기로 확인한 뒤 ✓ 로 확정, ✗ 로 취소.
 * 확정 = 명령 1건 (실행 취소 1번). 확정 전에는 설계 원본이 바뀌지 않는다.
 */
import type { ModelDefinition } from '../../cad/commandTypes';
import { topLevelObjects } from '../../cad/modelGraph';
import { findSketch, resolveProfile, revolveProfileError } from '../../cad/sketch';
import { useEditorStore } from '../../features/selection/editorStore';
import { cancelPending, commitPending } from '../../features/selection/featureFlow';
import { NumberField } from './NumberField';

import { ENTITY_LABEL } from './SketchFields';

export function PropertyManager({ model }: { model: ModelDefinition }) {
  const pending = useEditorStore((s) => s.pending)!;
  const setPending = useEditorStore((s) => s.setPending);
  const sketch = findSketch(model, pending.sketch);
  if (!sketch) return <p className="empty">스케치를 찾을 수 없습니다</p>;
  const profiles = sketch.entities.filter((e) => {
    const p = resolveProfile(sketch, e.id);
    return p && (pending.kind === 'extrude' || !revolveProfileError(p));
  });
  const title = pending.cutTarget ? (pending.kind === 'extrude' ? '돌출 컷' : '회전 컷') : pending.kind === 'extrude' ? '돌출 보스/베이스' : '회전 보스/베이스';

  return (
    <div className="props property-manager" data-testid="property-manager">
      <div className="pm-head">
        <strong>{title}</strong>
        <div className="pm-actions">
          <button className="ok" data-testid="pm-ok" title="확인 (Enter)" onClick={() => commitPending()}>
            ✓ 확인
          </button>
          <button className="cancel" data-testid="pm-cancel" title="취소 (Esc)" onClick={() => cancelPending()}>
            ✕ 취소
          </button>
        </div>
      </div>
      <fieldset>
        <legend>단면</legend>
        <div className="field">
          <label htmlFor="pm-profile">스케치 · 도형</label>
          <select
            id="pm-profile"
            data-testid="pm-profile"
            value={pending.profile}
            onChange={(e) => setPending({ ...pending, profile: e.target.value })}
          >
            {profiles.map((e) => (
              <option key={e.id} value={e.id}>
                {sketch.name} · {ENTITY_LABEL[e.type]} {e.id}
              </option>
            ))}
          </select>
        </div>
      </fieldset>
      {pending.kind === 'extrude' ? (
        <fieldset>
          <legend>방향 1</legend>
          <NumberField
            label="깊이"
            unit="mm"
            value={Math.abs(pending.distance)}
            onCommit={(v) => v > 0 && setPending({ ...pending, distance: Math.sign(pending.distance || 1) * v })}
            testId="pm-depth"
          />
          <label className="check">
            <input
              type="checkbox"
              data-testid="pm-reverse"
              checked={pending.distance < 0}
              onChange={(e) => setPending({ ...pending, distance: (e.target.checked ? -1 : 1) * Math.abs(pending.distance) })}
            />
            반대 방향 (면 안쪽으로 — 홈·구멍)
          </label>
        </fieldset>
      ) : (
        <fieldset>
          <legend>회전 매개변수</legend>
          <div className="muted small">회전축: 스케치의 v 축 (u = 0 인 선)</div>
          <NumberField label="각도" unit="°" value={pending.angle} onCommit={(v) => setPending({ ...pending, angle: v })} testId="pm-angle" />
        </fieldset>
      )}
      <fieldset>
        <legend>결과</legend>
        <div className="field">
          <label htmlFor="pm-cut">컷 (빼기)</label>
          <select
            id="pm-cut"
            data-testid="pm-cut"
            value={pending.cutTarget ?? ''}
            onChange={(e) => setPending({ ...pending, cutTarget: e.target.value || undefined })}
          >
            <option value="">새 바디 (보스/베이스)</option>
            {topLevelObjects(model).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} 에서 빼기
              </option>
            ))}
          </select>
        </div>
      </fieldset>
      <p className="muted small">뷰포트의 반투명 미리보기를 확인한 뒤 ✓ 를 누르세요. Enter = 확인, Esc = 취소.</p>
    </div>
  );
}
