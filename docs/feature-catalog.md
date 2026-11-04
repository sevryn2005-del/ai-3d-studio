# 기능 목록: 솔리드웍스 · 블렌더 전체 기능 대비 현황

목표(사용자): "솔리드웍스·인벤터·블렌더의 모든 기능을 누구나 쉽게, 부담 없이". 이 표가 그 목표의 진행표다.
✅ 완료(두 엔진·테스트) · 🟡 일부 · ⬜ 아직. 순서 = 구현 우선순위(위가 먼저). 묶음 단위로 구현 → 테스트 → 커밋.

엔진 제약: 브라우저 엔진(manifold, 메시)은 임의 모서리 필렛·구배·스윕 같은 B-rep 연산을 정확히 할 수 없다.
이런 기능은 서버/Windows 엔진(CadQuery/OCCT)에 먼저 넣고, 웹은 OCCT WASM(opencascade.js, LGPL-2.1, GPL-3.0 호환)
엔진을 같은 `CadEngine` 인터페이스 뒤에 추가해 맞춘다 (묶음 4).

## 1. 부품 모델링 (솔리드웍스 피처 / 블렌더 모디파이어)

| 기능 | 솔리드웍스 | 블렌더 | 상태 |
|------|-----------|--------|------|
| 기본 도형 (박스·원통·구·원뿔) | — | Add Mesh | ✅ |
| 돌출 보스/베이스, 돌출 컷(음수) | Extruded Boss/Cut | Extrude | ✅ |
| 회전 보스/베이스 | Revolved Boss | Spin/Screw | ✅ |
| 불리언 합치기·빼기·교차 | Combine | Boolean modifier | ✅ |
| 필렛·모따기 | Fillet/Chamfer | Bevel | 🟡 박스 모서리만 |
| 쉘 (속 비우기) | Shell | Solidify | ✅ 박스·원통·돌출 |
| 구멍 가공 (단순·카운터보어·카운터싱크) | Hole Wizard | — | ✅ |
| 선형 패턴 (1·2방향) | Linear Pattern | Array | ✅ |
| 원형 패턴 | Circular Pattern | Array + Empty | ✅ |
| 대칭 복사 | Mirror | Mirror modifier | ✅ |
| 피처 억제 / 해제 | Suppress | 모디파이어 끄기 | ✅ |
| 외관 색 · 숨기기 | Appearance / Hide | Material / Hide | ✅ |
| 돌출 컷 · 회전 컷 (다른 바디에서 빼기) | Extruded / Revolved Cut | Boolean | ✅ |
| 크기 조정 (균일·축별 배율) | Scale | Scale | ✅ |
| 헬릭스 스윕 (스프링·코일) | Swept along Helix | Screw modifier | ✅ |
| 스윕 (임의 경로) | Swept Boss/Cut | Curve bevel | ⬜ |
| 로프트 (단면 2~10개, 직선 연결) | Lofted Boss | Skin/Bridge | ✅ (안내 곡선 없음) |
| 구배 (빼기 각) | Draft | — | ⬜ (OCCT) |
| 리브 | Rib | — | ⬜ |
| 나사산: 수나사(원통에 감기)·암나사(구멍 벽에 홈, ISO 보통 피치) | Thread | Screw modifier | ✅ |
| 돔 · 랩 · 변형 | Dome / Wrap / Flex | Simple Deform | ⬜ |
| 곡선 패턴 · 스케치 구동 패턴 | Curve/Sketch Driven Pattern | Array on curve | ⬜ |
| 임의 모서리·면 필렛 / 가변 반경 | Fillet (edges/faces) | Bevel | ⬜ (OCCT, 면·모서리 선택 필요) |
| 면 이동·삭제·오프셋 | Move/Delete Face | — | ⬜ |
| 여러 바디 · 바디 분할 | Multibody / Split | Separate | ⬜ |

## 2. 스케치

| 기능 | 솔리드웍스 | 상태 |
|------|-----------|------|
| 사각형·원·다각형, 치수, 평면 XY/XZ/YZ, 면 위 스케치 | Sketch | ✅ |
| 기하 구속 11종 + 자유도·완전 정의 표시, 충돌 구속 진단 | Relations / SketchXpert | ✅ |
| 슬롯 (방향·길이·폭) | Straight Slot | ✅ |
| 직선 프로파일 경계·호·스플라인·타원 | Line/Arc/Spline/Ellipse | ⬜ |
| 스케치 오프셋 (사각형·원·슬롯·다각형) | Offset Entities | ✅ |
| 스케치 필렛·모따기·잘라내기·연장 | Sketch Fillet/Trim/Extend | ⬜ |
| 구성선 (구속 기준선) | Construction / Centerline | ✅ |
| 스케치 대칭·패턴 | Mirror/Pattern Entities | ⬜ |
| 각도 구속 | Angle | ✅ |
| 대칭 구속 | Symmetric | ⬜ |
| 뷰포트에서 꼭짓점 끌기, 구속 기호 표시 | Drag / Display relations | ⬜ |
| DXF/SVG 가져오기 | DXF import | ⬜ |
| 텍스트 (각인·양각) | Sketch Text | ⬜ |

## 3. 참조 형상

| 기능 | 상태 |
|------|------|
| 기준 평면 3개, 원점 | ✅ |
| 오프셋 평면, 각도 평면 (기준 평면을 u·v 축 둘레로) | ✅ |
| 세 점·면 기준 평면, 축, 점, 좌표계 | ⬜ |

## 4. 보기 · 분석

| 기능 | 솔리드웍스 / 블렌더 | 상태 |
|------|--------------------|------|
| 표준 보기 Ctrl+1~8, 화면 맞춤, 보기 방향 메뉴 | View Orientation / Numpad | ✅ |
| 마우스 방식 (솔리드웍스식 / 간편) | — | ✅ |
| 표시 모드: 음영+모서리·음영·와이어프레임·투명 | Display Style / Shading, X-ray | ✅ |
| 단면 보기 (X/Y/Z, 위치, 반대쪽) | Section View / Clipping | ✅ (단면 덮개 없음) |
| 측정 (두 점 거리, ΔX·ΔY·ΔZ) | Measure / MeasureIt | ✅ |
| 질량 특성 (부피·겉넓이·무게 중심·크기·재료별 질량) | Mass Properties / 3D Print Toolbox | ✅ |
| 화면 이미지 저장 (PNG) | Save image / Render | ✅ |
| 출력 전 검사 (바닥·떠 있음·크기·얇음·겹침) | — / 3D Print Toolbox | ✅ |
| 원근/직교 투영 전환 | Perspective / Numpad 5 | ✅ |
| 간섭 검사 · 구배 분석 · 두께 분석 | Interference / Draft / Thickness | ⬜ |
| 측정: 면·모서리 선택, 각도, 반지름 | Measure | ⬜ |

## 5. 파일

| 기능 | 상태 |
|------|------|
| 프로젝트 저장·열기(.ai3d), 자동 임시 저장·복원, 구버전 읽기 | ✅ |
| 내보내기 STL·3MF·STEP·GLB | ✅ (STEP 은 서버 엔진) |
| 가져오기 STL·OBJ (메시 객체, 미터 단위 자동 보정) | ✅ (서버 엔진은 2만 삼각형까지) |
| 가져오기 STEP | ⬜ (묶음 4: 브라우저 OCCT) |
| 3MF 색 내보내기 | ✅ |
| 도면 PDF·DXF | ⬜ (7장) |

## 6. 조립품 (솔리드웍스 Assembly / 인벤터)

⬜ 부품 삽입(다른 .ai3d), 메이트(일치·평행·동심·거리·각도), 자유도, 간섭 검사, 분해도, BOM, 움직임 시뮬레이션.

## 7. 도면 (Drawing)

⬜ 투상도(정면·평면·측면·등각), 단면도·상세도, 치수·주석·공차, 표제란, PDF/DXF 내보내기.

## 8. 판금 · 용접 구조 · 금형 · 곡면 (솔리드웍스 전문 모듈)

⬜ 판금(베이스 플랜지·엣지 플랜지·굽힘·전개), 용접 구조(구조 부재·트림), 금형(파팅 라인·코어/캐비티),
곡면(경계 곡면·채움·트림·두껍게).

## 9. 블렌더 고유 영역

| 영역 | 내용 | 상태 |
|------|------|------|
| 메시 편집 | 정점·모서리·면 선택, 이동·돌출·인셋·루프컷·병합·분할 | ⬜ |
| 모디파이어 | Array·Mirror·Solidify·Boolean ✅(피처로) / Subdivision·Smooth·Remesh·Decimate·Displace | 🟡 |
| 스컬프트 | 브러시(그랩·스무스·클레이), 다이나믹 토폴로지 | ⬜ |
| 재질 · UV · 텍스처 | 색 ✅ / PBR 재질·UV 펼치기·텍스처 페인트 | 🟡 |
| 렌더 | 조명·환경(로컬 HDRI)·실사 렌더(경로 추적) | ⬜ |
| 애니메이션 · 리깅 | 키프레임·뼈대·웨이트 | ⬜ |
| 물리 · 노드 · 그리스펜슬 · 영상 편집 | 시뮬레이션·지오메트리 노드·2D 애니메이션·VSE | ⬜ |

## 10. 해석 (Simulation)

⬜ 정적 응력(FEA, 오픈소스 솔버 호출 — CalculiX GPL-2.0+ 는 별도 프로그램으로), 열, 진동, 유동.

## 구현 순서 (묶음)

1. ✅ 묶음 1 (형식 v6): 억제·외관·숨기기·쉘·구멍·선형/원형 패턴·대칭 + 보기 도구 (표시 모드·단면·측정·질량 특성·PNG)
2. ✅ 묶음 2 (형식 v7): 돌출·회전 컷, 크기 조정, 원근/직교, 각도 평면, 스케치 슬롯·구성선·각도 구속
   (남은 스케치 요소 — 호·스플라인·잘라내기·오프셋 — 는 묶음 3에 합침)
3. ✅ 묶음 3 (형식 v8): 로프트, 헬릭스·나사산, STL·OBJ 가져오기, 스케치 오프셋, 3MF 색
   (남은 것 → 묶음 4: 스케치 호·필렛·잘라내기, 임의 경로 스윕, 리브, STEP 가져오기)
4. 묶음 4: 브라우저 OCCT(WASM) 엔진 → 임의 모서리 필렛·구배·면 선택 (웹·Windows 동일)
5. 묶음 5: 조립품 (부품 삽입·메이트) → 묶음 6: 도면
6. 이후: 메시 편집·스컬프트(블렌더), 판금, 렌더, 해석, 애니메이션
