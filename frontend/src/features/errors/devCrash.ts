/** 개발·E2E 전용: 화면 한 부분을 일부러 고장 내 오류 경계(ErrorBoundary)를 시험한다. 배포 빌드에서는 그리지 않는다 */
import { create } from 'zustand';

export const useDevCrash = create<{ crash: boolean; set: (crash: boolean) => void }>((set) => ({ crash: false, set: (crash) => set({ crash }) }));

export function DevCrashProbe() {
  const crash = useDevCrash((s) => s.crash);
  if (crash) throw new Error('시험용 고장'); // 오류 경계의 "다시 그리기"가 끈다
  return null;
}
