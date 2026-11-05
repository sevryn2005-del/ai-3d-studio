import { useState } from 'react';
import { useModelingStore, type SelectMode } from '../../features/modeling/modelingStore';
import {
  ADD_MESH_ITEMS, addMesh, canStartModal, deleteSelection, densify, enterSculpt, fillSelected, loopCutSelected, mergeSelected, selectAll, subdivideSelected, toggleEditMode,
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
          <button onClick={() => modal('bevel')} title="고른 선 모따기 (Ctrl+B) — 마우스로 폭, 숫자 입력" data-testid="op-bevel">베벨</button>
          <button onClick={subdivideSelected} title="고른 면 세분 (W)">세분</button>
          <button onClick={mergeSelected} title="가운데로 병합 (M)">병합 M</button>
          <button onClick={fillSelected} title="고른 점으로 면 만들기 (F)">면 F</button>
          <button onClick={() => selectAll()} title="전체 선택 (A) · 해제 (Alt+A)">전체 A</button>
        </>
      )}
      {mode !== 'sculpt' && (
        <button onClick={deleteSelection} title="삭제 (X · Delete)" data-testid="op-delete">삭제 X</button>
      )}
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
      <button onClick={densify} title="세분 표면 1단계를 메시에 적용해 점을 늘립니다 (스컬프트가 더 부드럽게)" data-testid="sculpt-densify">
        촘촘하게
      </button>
    </>
  );
}
