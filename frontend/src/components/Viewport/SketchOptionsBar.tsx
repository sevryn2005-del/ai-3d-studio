import { formatMm } from '../../cad/units';
import { useActiveSketch } from '../../features/sketch/activeSketch';
import { GRID_STEP_OPTIONS, gridSteps, useSketchView, type GridStepPref } from '../../features/sketch/sketchSettings';
import { useEditorStore } from '../../features/selection/editorStore';

/**
 * 스케치 중 뷰포트 왼쪽 위 막대: 종이 · 격자 · 격자 스냅 · 점/정렬 스냅 · 격자 간격 · 스케치에 수직 보기.
 * 설정은 이 브라우저에 저장된다 (다음에도 그대로).
 */
export function SketchOptionsBar() {
  const active = useActiveSketch();
  const v = useSketchView();
  const drawTool = useEditorStore((s) => s.drawTool);
  if (!active) return null;
  const steps = gridSteps(v);
  const toggle = (k: 'paper' | 'grid' | 'gridSnap' | 'inference' | 'autoRelations' | 'relations', label: string, title: string) => (
    <button aria-pressed={v[k]} onClick={() => v.set({ [k]: !v[k] })} title={title} data-testid={`sketch-opt-${k}`}>
      {label}
    </button>
  );
  return (
    <div className="sketch-options" role="toolbar" aria-label="스케치 보기 설정" data-testid="sketch-options">
      {toggle('paper', '종이', '종이 배경 (모눈종이처럼) 켜기/끄기')}
      {toggle('grid', '격자', '격자 선 보이기/숨기기')}
      {toggle('gridSnap', '격자 스냅', '점을 격자에 맞춰 찍기 (끄면 0.01mm 단위)')}
      {toggle('inference', '점·정렬 스냅', '끝점·중심·중간점·원점에 붙고, 다른 점과 수평·수직으로 맞추기')}
      {toggle('relations', '구속 표시', '선·점 옆에 구속 기호(― 수평, ｜ 수직, ● 일치, ⊕ 고정, M 중간점 …)와 치수 표시')}
      {toggle('autoRelations', '자동 구속', '그릴 때 붙은 점은 일치, 정렬은 수평·수직, 가로·세로 변은 수평·수직, 원점은 고정, 숫자로 친 길이는 길이 구속')}
      <label className="grid-step" title="격자 간격 (자동 = 확대에 맞춰 바뀜)">
        간격
        <select
          value={String(v.gridStep)}
          onChange={(e) => v.set({ gridStep: (e.target.value === 'auto' ? 'auto' : Number(e.target.value)) as GridStepPref })}
          data-testid="sketch-grid-step"
        >
          {GRID_STEP_OPTIONS.map((o) => (
            <option key={String(o)} value={String(o)}>
              {o === 'auto' ? `자동 (${formatMm(v.auto.minor)}mm)` : `${o}mm`}
            </option>
          ))}
        </select>
      </label>
      <span className="grid-scale" data-testid="sketch-grid-scale">
        칸 {formatMm(steps.minor)} · 굵은 칸 {formatMm(steps.major)} mm
      </span>
      <button onClick={() => useEditorStore.getState().requestView('normal')} title="스케치 평면을 정면으로 보기 (Ctrl+8)">
        수직 보기
      </button>
      {!drawTool && <span className="sketch-tips">꼭짓점·중심을 끌면 구속을 지키며 움직입니다</span>}
      {drawTool && <span className="sketch-tips">숫자: 길이 입력 (Tab 다음 칸) · Shift: 정사각형·15° · Backspace: 마지막 점 지우기</span>}
    </div>
  );
}
