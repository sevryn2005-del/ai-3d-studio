/**
 * 판금 속성 (형식 v45): 전개도(flat pattern) 미리보기 · 크기 · 굽힘 허용량 · DXF 저장 (레이저·절곡 업체에 보내는 2D).
 * 전개는 화면 계산만 (모델은 그대로) — cad/sheetMetal.ts
 */
import { useMemo } from 'react';
import type { CadObject } from '../../cad/commandTypes';
import { bendAllowance, flatPattern, flatPatternDxf } from '../../cad/sheetMetal';
import { formatMm } from '../../cad/units';
import { downloadBlob } from '../../features/projects/projectStorage';

export function SheetMetalFields({ object }: { object: Extract<CadObject, { kind: 'sheet' }> }) {
  const flat = useMemo(() => flatPattern(object.params), [object.params]);
  const ba = bendAllowance(object.params);
  const xs = flat.outline.map((p) => p[0]);
  const ys = flat.outline.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = Math.max(maxX - minX, maxY - minY) * 0.04;
  // SVG 는 y 가 아래로 → 뒤집어 그린다
  const pts = flat.outline.map(([x, y]) => `${x},${-y}`).join(' ');
  return (
    <fieldset data-testid="sheet-flat">
      <legend>전개도</legend>
      <svg
        viewBox={`${minX - pad} ${-maxY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`}
        style={{ width: '100%', maxHeight: 180, background: 'var(--panel-2, transparent)' }}
        role="img"
        aria-label="판금 전개도"
      >
        <polygon points={pts} fill="rgba(80,150,255,0.15)" stroke="currentColor" strokeWidth={pad * 0.15} vectorEffect="non-scaling-stroke" />
        {flat.bendLines.map(([a, b], i) => (
          <line key={i} x1={a[0]} y1={-a[1]} x2={b[0]} y2={-b[1]} stroke="#e8a33d" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <p className="muted small" data-testid="sheet-flat-size">
        전개 크기 {formatMm(flat.size[0])} × {formatMm(flat.size[1])}mm · 굽힘 허용량 {formatMm(ba)}mm (K {object.params.kFactor})
      </p>
      <button
        onClick={() => void downloadBlob(new Blob([flatPatternDxf(flat)], { type: 'application/dxf' }), `${object.name}-전개도.dxf`)}
        title="윤곽(OUTLINE)·굽힘선(BEND) 레이어로 나눈 2D DXF — 레이저 절단·절곡용"
        data-testid="sheet-dxf"
      >
        전개도 DXF 저장
      </button>
    </fieldset>
  );
}
