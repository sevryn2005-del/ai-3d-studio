/**
 * 명령 버튼 기호 (자체 제작 SVG, 24×24 선 그림). 글꼴 기호(◯ ⬠ 등)는 글꼴마다 크기가 달라 버튼이 들쭉날쭉해진다.
 * 상용 CAD 프로그램의 아이콘을 베끼지 않는다 — 동작을 나타내는 단순한 모양만.
 */
const PATHS: Record<string, string> = {
  extrude: 'M4 17l8 4 8-4M4 17V9l8-4 8 4v8M12 21v-8M4 9l8 4 8-4M12 5V1m0 0l-3 3m3-3l3 3',
  revolve: 'M12 3v18M7 7a7 3 0 1 0 10 0M16 4.5L17 7l-2.6.6',
  sketch: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
  rectangle: 'M4 6h16v12H4z',
  circle: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16z',
  polygon: 'M12 3l8.5 6.2-3.2 10H6.7L3.5 9.2z',
  front: 'M5 5h14v14H5z',
  top: 'M3 9l6-5h12l-6 5zM3 9h12v11H3z',
  right: 'M9 4h12v12H9zM9 4L3 9v11l6-4M3 20h12',
  iso: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
  normal: 'M5 19h14M12 19V5m0 0l-3 3m3-3l3 3',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5M9 9h6v6H9z',
};

export type IconName = keyof typeof PATHS;

export function CmdIcon({ name }: { name: IconName }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
