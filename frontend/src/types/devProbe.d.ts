/** 개발 모드 전용 테스트 훅 (DevProbe.tsx 가 설정, E2E 테스트가 사용) */
export {};

declare global {
  interface Window {
    __AI3D_DEV__?: {
      project: (x: number, y: number, z: number) => { x: number; y: number };
      /** 카메라가 바라보는 방향 (월드, 단위 벡터) */
      cameraDir: () => number[];
      /** 객체 ID → 표시 중인 형상 출처와 실제 지오메트리의 월드 바운딩 박스 (mm) */
      meshSources: () => Record<string, { source: string; min: number[]; max: number[]; vertices: number }>;
      /** 설계 원본·이력 상태 (리비전, 이력 길이, 마지막 커밋의 명령 ID·기준 리비전·명령) */
      scene: () => {
        revision: number;
        past: number;
        future: number;
        commandId: string | null;
        baseRevision: number | null;
        command: unknown;
        objects: { id: string; position: number[]; rotation: number[] }[];
        sketches: { id: string; plane: Record<string, unknown>; entities: { id: string; type: string; center?: number[]; points?: number[][] }[]; constraints: { type: string; refs: string[] }[] }[];
        mates: { id: string; type: string; refs: unknown[] }[];
      };
      /** 명령 봉투를 직접 제출 (재시도·오래된 리비전 시험용) */
      submit: (envelope: unknown) => unknown;
      dispatch: (command: unknown) => unknown;
    };
  }
}
