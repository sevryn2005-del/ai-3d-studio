import { useState } from 'react';
import { useModelingStore, type SelectMode } from '../../features/modeling/modelingStore';
import {
  ADD_MESH_ITEMS, addMesh, canStartModal, deleteSelection, fillSelected, loopCutSelected, mergeSelected, selectAll, subdivideSelected, toggleEditMode,
} from '../../features/modeling/modelingOps';
import { useEditorStore } from '../../features/selection/editorStore';

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
  const modal = (k: 'grab' | 'rotate' | 'scale' | 'extrude' | 'inset') => {
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
      </div>
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
      <button onClick={() => modal('grab')} title="이동 (G) — X/Y/Z 로 축 고정, 숫자 입력, 클릭·Enter 확정">이동 G</button>
      <button onClick={() => modal('rotate')} title="회전 (R)">회전 R</button>
      <button onClick={() => modal('scale')} title="크기 (S)">크기 S</button>
      {mode === 'edit' && (
        <>
          <span className="sep" />
          <button onClick={() => modal('extrude')} title="면 돌출 (E)" data-testid="op-extrude">돌출 E</button>
          <button onClick={() => modal('inset')} title="면 인셋 (I)" data-testid="op-inset">인셋 I</button>
          <button onClick={loopCutSelected} title="고른 선을 가로지르는 고리 (Ctrl+R)" data-testid="op-loopcut">루프 컷</button>
          <button onClick={subdivideSelected} title="고른 면 세분 (W)">세분</button>
          <button onClick={mergeSelected} title="가운데로 병합 (M)">병합 M</button>
          <button onClick={fillSelected} title="고른 점으로 면 만들기 (F)">면 F</button>
          <button onClick={() => selectAll()} title="전체 선택 (A) · 해제 (Alt+A)">전체 A</button>
        </>
      )}
      <button onClick={deleteSelection} title="삭제 (X · Delete)" data-testid="op-delete">삭제 X</button>
      <span className="spacer" />
      <button onClick={editor.toggleProjection} title="원근/직교 (숫자패드 5)">{projection === 'perspective' ? '원근' : '직교'}</button>
      <button onClick={editor.requestFit} title="화면 맞춤 (Home · 숫자패드 .)">화면 맞춤</button>
    </div>
  );
}
