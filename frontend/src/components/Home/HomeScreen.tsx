/**
 * 시작 화면: 작업 모드를 고른다.
 * - 설계: 평면을 골라 2D 스케치(치수·구속) → 돌출·회전 같은 피처로 부품 → 도면 (솔리드웍스식 흐름)
 * - 3D 모델링: 메시를 점·선·면으로 직접 다듬는다 (블렌더식 흐름)
 * 자동 저장된 작업이 있으면 "이어서 작업", 파일 열기도 여기서.
 */
import { useMemo } from 'react';
import { readDraft } from '../../features/projects/draft';
import { openProject, restoreDraft, startNew } from '../../features/projects/projectActions';
import { CmdIcon } from '../Toolbar/CmdIcon';

export function HomeScreen() {
  const draft = useMemo(() => readDraft(), []);
  const draftMode = draft?.project.model.workspace;
  return (
    <div className="home" data-testid="home">
      <header className="home-head">
        <h1>AI 3D Studio</h1>
        <p className="muted">무엇을 만들까요? 작업 방식을 고르세요. (모든 계산은 이 컴퓨터에서, AI 는 원할 때만)</p>
      </header>
      <div className="home-modes">
        <button className="home-card" onClick={() => startNew('design')} data-testid="home-design">
          <span className="home-icon" aria-hidden>
            <CmdIcon name="sketch" />
          </span>
          <strong>설계</strong>
          <span className="home-sub">부품 설계 · 솔리드웍스 방식</span>
          <ol className="home-steps">
            <li>평면(정면·윗면·우측면)을 골라 2D 스케치</li>
            <li>치수·구속으로 모양을 정확히</li>
            <li>돌출·회전·스윕으로 3D 부품</li>
            <li>필렛·구멍·패턴, 조립품, 도면</li>
          </ol>
        </button>
        <button className="home-card" disabled title="다음 단계에서 열립니다" data-testid="home-modeling">
          <span className="home-icon" aria-hidden>
            <CmdIcon name="shadedEdges" />
          </span>
          <strong>3D 모델링</strong>
          <span className="home-sub">자유 형상 · 블렌더 방식 — 준비 중 (다음 단계)</span>
          <ol className="home-steps">
            <li>Shift+A 로 메시 추가 (큐브·구·원통 …)</li>
            <li>Tab 으로 편집 모드: 점·선·면 선택</li>
            <li>G·R·S 이동·회전·크기, E 돌출, I 인셋</li>
            <li>모디파이어로 매끈하게·대칭·반복</li>
          </ol>
        </button>
      </div>
      <div className="home-actions">
        {draft && (
          <button onClick={() => restoreDraft()} data-testid="home-resume">
            이어서 작업: {draft.project.name}
            {draftMode ? ` (${draftMode === 'design' ? '설계' : '3D 모델링'})` : ''}
          </button>
        )}
        <button onClick={() => void openProject()} data-testid="home-open">
          파일 열기 (.ai3d)
        </button>
      </div>
    </div>
  );
}
