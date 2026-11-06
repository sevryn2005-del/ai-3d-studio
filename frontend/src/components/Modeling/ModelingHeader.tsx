import { useState } from 'react';
import { useModelingStore, type SelectMode } from '../../features/modeling/modelingStore';
import {
  ADD_MESH_ITEMS, addMesh, canStartModal, deleteSelection, densify, remeshTarget, enterSculpt, invertMask, fillSelected, loopCutSelected, mergeSelected, selectAll, subdivideSelected, toggleEditMode,
} from '../../features/modeling/modelingOps';
import { useEditorStore } from '../../features/selection/editorStore';
import { BRUSH_LABEL, type Brush } from '../../cad/sculpt';

const SELECT_MODES: { id: SelectMode; label: string; key: string }[] = [
  { id: 'vert', label: '점', key: '1' },
  { id: 'edge', label: '선', key: '2' },
  { id: 'face', label: '면', key: '3' },
];

/**
 * 3D 모델링 모드 헤더 (블렌더 3D 뷰포트 헤더 흐름): 모드 · 선택 모드 · 추가 · 메시 연산 · 보기.
 * 모든 버튼은 단축키와 같은 동작 (modelingOps) — 단축키를 몰라도 쓸 수 있게.
 */
export function ModelingHeader() {
  const mode = useModelingStore((s) => s.mode);
  const selectMode = useModelingStore((s) => s.selectMode);
  const st = useModelingStore.getState();
  const editor = useEditorStore.getState();
  const projection = useEditorStore((s) => s.projection);
  const [addOpen, setAddOpen] = useState(false);
  const modal = (k: 'grab' | 'rotate' | 'scale' | 'extrude' | 'inset' | 'bevel') => {
    if (canStartModal(k)) st.startModal(k);
  };

  return (
    <div className="modeling-header" role="toolbar" aria-label="3D 모델링">
      <div className="seg" role="group" aria-label="모드">
        <button aria-pressed={mode === 'object'} onClick={() => mode !== 'object' && toggleEditMode()} data-testid="mode-object" title="오브젝트 모드 (Tab)">
          오브젝트 모드
        </button>
        <button aria-pressed={mode === 'edit'} onClick={() => mode !== 'edit' && toggleEditMode()} data-testid="mode-edit" title="편집 모드 — 점·선·면 고치기 (Tab)">
          편집 모드
        </button>
        <button aria-pressed={mode === 'sculpt'} onClick={() => mode !== 'sculpt' && enterSculpt()} data-testid="mode-sculpt" title="스컬프트 모드 — 브러시로 주물러 다듬기">
          스컬프트
        </button>
      </div>
      {mode === 'sculpt' && <SculptBar />}
      {mode === 'edit' && (
        <div className="seg" role="group" aria-label="선택 모드">
          {SELECT_MODES.map((m) => (
            <button key={m.id} aria-pressed={selectMode === m.id} onClick={() => st.setSelectMode(m.id)} title={`${m.label} 선택 (${m.key})`} data-testid={`select-${m.id}`}>
              {m.label}
            </button>
          ))}
        </div>
      )}
      <span className="sep" />
      <div className="menu-wrap">
        <button onClick={() => setAddOpen((o) => !o)} aria-expanded={addOpen} data-testid="add-menu-button" title="메시 추가 (Shift+A)">
          추가 ▾
        </button>
        {addOpen && (
          <div className="mmenu" role="menu" onMouseLeave={() => setAddOpen(false)}>
            {ADD_MESH_ITEMS.map((i) => (
              <button key={i.primitive} role="menuitem" onClick={() => { addMesh(i.primitive); setAddOpen(false); }}>
                {i.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {mode !== 'sculpt' && (
        <>
          <button onClick={() => modal('grab')} title="이동 (G) — X/Y/Z 로 축 고정, 숫자 입력, 클릭·Enter 확정">이동 G</button>
          <button onClick={() => modal('rotate')} title="회전 (R)">회전 R</button>
          <button onClick={() => modal('scale')} title="크기 (S)">크기 S</button>
        </>
      )}
      {mode === 'edit' && (
        <>
          <span className="sep" />
          <button onClick={() => modal('extrude')} title="면 돌출 (E)" data-testid="op-extrude">돌출 E</button>
          <button onClick={() => modal('inset')} title="면 인셋 (I)" data-testid="op-inset">인셋 I</button>
          <button onClick={loopCutSelected} title="고른 선을 가로지르는 고리 (Ctrl+R)" data-testid="op-loopcut">루프 컷</button>
          <button onClick={() => useModelingStore.getState().setKnife({ a: null, b: null })} title="나이프 (K): 화면에 선을 그어 면 자르기 (고른 면, 없으면 전부)" data-testid="op-knife">나이프 K</button>
          <button onClick={() => modal('bevel')} title="고른 선 모따기 (Ctrl+B) — 마우스로 폭, 숫자 입력" data-testid="op-bevel">베벨</button>
          <button onClick={subdivideSelected} title="고른 면 세분 (W)">세분</button>
          <button onClick={mergeSelected} title="가운데로 병합 (M)">병합 M</button>
          <button onClick={fillSelected} title="고른 점으로 면 만들기 (F)">면 F</button>
          <button onClick={() => selectAll()} title="전체 선택 (A) · 해제 (Alt+A)">전체 A</button>
          <ProportionalToggle />
        </>
      )}
      {mode !== 'sculpt' && (
        <button onClick={deleteSelection} title="삭제 (X · Delete)" data-testid="op-delete">삭제 X</button>
      )}
      <SnapToggle />
      <span className="spacer" />
      <button onClick={editor.toggleProjection} title="원근/직교 (숫자패드 5)">{projection === 'perspective' ? '원근' : '직교'}</button>
      <button onClick={editor.requestFit} title="화면 맞춤 (Home · 숫자패드 .)">화면 맞춤</button>
    </div>
  );
}

const BRUSHES: { id: Brush; key: string }[] = [
  { id: 'draw', key: 'X' },
  { id: 'inflate', key: 'I' },
  { id: 'smooth', key: 'S' },
  { id: 'grab', key: 'G' },
  { id: 'flatten', key: 'Shift+T' },
  { id: 'clay', key: 'C' },
  { id: 'crease', key: 'Shift+C' },
  { id: 'mask', key: 'M' },
];

/** 스컬프트 도구 막대: 브러시 · 반지름(화면 px) · 세기 · X 대칭 · 촘촘하게 */
function SculptBar() {
  const sc = useModelingStore((s) => s.sculpt);
  const set = useModelingStore.getState().setSculpt;
  return (
    <>
      <span className="sep" />
      <div className="seg" role="group" aria-label="브러시">
        {BRUSHES.map((b) => (
          <button key={b.id} aria-pressed={sc.brush === b.id} onClick={() => set({ brush: b.id })} title={`${BRUSH_LABEL[b.id]} (${b.key})`} data-testid={`brush-${b.id}`}>
            {BRUSH_LABEL[b.id]}
          </button>
        ))}
      </div>
      <label className="slider" title="브러시 반지름 (화면 픽셀, [ ] 키)">
        반지름
        <input type="range" min={5} max={400} value={sc.radiusPx} onChange={(e) => set({ radiusPx: Number(e.target.value) })} data-testid="sculpt-radius" />
        <span>{sc.radiusPx}px</span>
      </label>
      <label className="slider" title="브러시 세기">
        세기
        <input type="range" min={0.05} max={1} step={0.05} value={sc.strength} onChange={(e) => set({ strength: Number(e.target.value) })} data-testid="sculpt-strength" />
        <span>{Math.round(sc.strength * 100)}%</span>
      </label>
      <button aria-pressed={sc.symmetryX} onClick={() => set({ symmetryX: !sc.symmetryX })} title="X 대칭 — 객체 x = 0 평면 반대쪽에도" data-testid="sculpt-symmetry">
        X 대칭
      </button>
      <button onClick={() => useModelingStore.getState().setMask(null)} title="마스크 지우기 (Alt+M)" data-testid="mask-clear">마스크 지우기</button>
      <button onClick={invertMask} title="마스크 뒤집기 (Ctrl+I)" data-testid="mask-invert">뒤집기</button>
      <button onClick={densify} title="세분 표면 1단계를 메시에 적용해 점을 늘립니다 (스컬프트가 더 부드럽게)" data-testid="sculpt-densify">
        촘촘하게
      </button>
      <label className="slider" title="리메시 복셀 크기 (mm, 0 = 자동: 가장 긴 변의 1/40)">
        복셀
        <input type="number" min={0} step={0.5} value={sc.voxel} onChange={(e) => Number(e.target.value) >= 0 && set({ voxel: Number(e.target.value) })} data-testid="sculpt-voxel" style={{ width: 52 }} />
      </label>
      <button onClick={remeshTarget} title="복셀 리메시 (Ctrl+R): 고른 사각형 그물로 다시 짭니다 — 늘어난 면을 고르게, 겹친 조각은 하나로" data-testid="sculpt-remesh">
        리메시
      </button>
    </>
  );
}

/** 비례 편집 (O): 켜면 G/R/S 때 반지름 안 점도 부드럽게 따라온다. 반지름은 조작 중 휠 */
function ProportionalToggle() {
  const p = useModelingStore((s) => s.proportional);
  const set = useModelingStore.getState().setProportional;
  return (
    <>
      <button aria-pressed={p.enabled} onClick={() => set({ enabled: !p.enabled })} title="비례 편집 (O) — G/R/S 때 주변 점도 부드럽게 (조작 중 휠·PageUp/Down 으로 반지름)" data-testid="proportional">
        비례 편집 O
      </button>
      {p.enabled && (
        <label className="slider" title="비례 편집 반지름 (mm)">
          <input type="number" min={0.1} step={1} value={Math.round(p.radius * 10) / 10} onChange={(e) => Number(e.target.value) > 0 && set({ radius: Number(e.target.value) })} data-testid="proportional-radius" style={{ width: 56 }} />
          <span>mm</span>
        </label>
      )}
    </>
  );
}

/** 스냅 (Shift+Tab): 단위(1mm·5°·0.1배) 또는 점에 붙기. 조작 중 Ctrl = 이번만 반대 */
function SnapToggle() {
  const snap = useModelingStore((s) => s.snap);
  const set = useModelingStore.getState().setSnap;
  return (
    <>
      <span className="sep" />
      <button aria-pressed={snap.enabled} onClick={() => set({ enabled: !snap.enabled })} title="스냅 켜기·끄기 (Shift+Tab) — G/R/S 중 Ctrl 을 누르면 이번만 반대" data-testid="snap-toggle">
        스냅
      </button>
      <select value={snap.target} onChange={(e) => set({ target: e.target.value as 'increment' | 'vertex' })} aria-label="스냅 대상" data-testid="snap-target" className="snap-target">
        <option value="increment">단위 (1mm·5°)</option>
        <option value="vertex">점에 붙기</option>
      </select>
    </>
  );
}
