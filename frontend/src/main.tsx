import './cad/zUp'; // 반드시 three 객체 생성 전에 로드 (Z-up 좌표계)
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/app.css';
import { restoreDraft } from './features/projects/projectActions';
import { skipHome } from './features/projects/appScreen';
import { setBrowserEngine } from './features/engine/engines';
import { createBrowserEngine } from './features/engine/browser/browserEngine';

// 브라우저 CAD 엔진 등록 (워커·WASM 은 처음 사용할 때 로드)
setBrowserEngine(createBrowserEngine());

// 홈을 건너뛰는 시작(개발·기존 E2E)은 첫 렌더 전에 자동 저장본을 복원 → 기본 모델이 잠깐 보이거나 불필요한 서버 계산이 없음.
// 보통은 시작 화면에서 "이어서 작업" 으로 복원한다
if (skipHome()) restoreDraft();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
