import './cad/zUp'; // 반드시 three 객체 생성 전에 로드 (Z-up 좌표계)
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/app.css';
import { restoreDraft } from './features/projects/projectActions';
import { setBrowserEngine } from './features/engine/engines';
import { createBrowserEngine } from './features/engine/browser/browserEngine';

// 브라우저 CAD 엔진 등록 (워커·WASM 은 처음 사용할 때 로드)
setBrowserEngine(createBrowserEngine());

// 첫 렌더 전에 복원 → 기본 모델이 잠깐 보이거나 불필요한 서버 계산이 일어나지 않음
restoreDraft();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
