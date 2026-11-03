/** 개발 모드 전용 테스트 훅 (DevProbe.tsx 가 설정, E2E 테스트가 사용) */
export {};

declare global {
  interface Window {
    __AI3D_DEV__?: {
      project: (x: number, y: number, z: number) => { x: number; y: number };
      /** 객체 ID → 표시 중인 형상 출처와 실제 지오메트리의 월드 바운딩 박스 (mm) */
      meshSources: () => Record<string, { source: string; min: number[]; max: number[]; vertices: number }>;
    };
  }
}
