# 다른 CAD·블렌더의 실사용 문제 → 우리 앱 점검 결과

작성: 2026-11-03 · 대상: SolidWorks · Inventor · Blender (+ 같은 계열 Fusion·Onshape·FreeCAD 사례)

사용자 포럼·공식 도움말에서 실제로 보고된 문제를 모으고, 같은 상황을 우리 앱(브라우저 엔진 manifold, 서버 엔진 CadQuery/OCCT)에서
재현 테스트로 만들어 확인했다. 실패한 것은 고쳤고, 테스트로 남겨 다시 생기지 않게 했다.

출처 범위: 웹 검색 결과에 나온 페이지(URL은 부록). help.solidworks.com·docs.blender.org 는 이 개발 환경의 네트워크 허용 목록에
없어 원문을 직접 열지는 못했고, 검색 요약을 근거로 했다.

## 1. 우선 확인 10개 — 결과

| # | 문제 (다른 프로그램) | 우리 앱 결과 | 근거(테스트) |
|---|----------------------|--------------|--------------|
| 1 | STL 에 단위가 없어 1/25.4·1/1000 크기로 들어감 | ✅ 문제 없음: STL 은 mm 그대로(20mm 큐브 = 20), 3MF 는 `unit="millimeter"` | `test_export.py`, `exporters.test.ts` |
| 2 | glTF(GLB) 는 미터·Y-up → 1000배·90° 누움 | ✅ 문제 없음: 두 엔진 모두 ×0.001, Z-up→Y-up 변환 | `test_glb_structure_and_y_up_meters`, `exporters.test.ts` |
| 3 | 맞닿은 면·같은 평면 관통 컷·접하는 컷·축 위 회전 → 비다양체·뒤집힌 법선 | ⚠→✅ **서버 STL 에서 결함 발견·수정**: 원뿔 꼭짓점(회전축 위 점)에 넓이 0 삼각형이 남아 열린 모서리로 보였음 → STL 도 3MF 처럼 정점 병합·퇴화 삼각형 제거. 6개 사례 모두 두 엔진에서 닫힌 메시·바깥 법선·같은 부피 | 공유 픽스처 `survey-cases.json`, `test_issue_survey.py`, `issueSurvey.test.ts` |
| 4 | 필렛 반지름 과대 → 재빌드 실패, 이유 불명 | ✅ 문제 없음: 경계(가장 짧은 변의 절반) 두 엔진 동일, 실패 시 원본 유지 + "5mm 보다 작아야" 안내 | 같은 두 파일 4-1 |
| 5 | 치수를 줄이면 기존 필렛이 조용히 깨짐 | ✅ 문제 없음: 높이 변경 명령이 이유와 함께 거부되고 원본 유지, 서버 검사도 같은 메시지 | 3-2 테스트 |
| 6 | 크래시·탭 종료로 작업 손실, 저장 중 실패로 파일 손상 | ✅ 문제 없음: 저장 안 한 프로젝트도 자동 임시 저장으로 복원, 저장은 임시 사본 후 교체(실패 시 기존 파일 그대로), 더 새 버전 파일은 "앱을 업데이트하세요" | `project.spec.ts` |
| 7 | 보이지 않는 틈·중복 점·자기 교차로 "열린 윤곽" | ⚠→✅ **결함 발견·수정**: 첫 점과 끝 점이 1e-5mm 떨어진 다각형이 통과했음 → 변 최소 길이 0.01mm(출력 허용 오차)를 두 구현에 적용, 어느 변·점인지 알려 줌. 회전축을 넘는 회전은 원래 거부 | `polygonError`/`polygon_error`, 2-4 테스트 |
| 8 | 과구속 시 어떤 구속을 지워야 할지 모름, 치수 바꾸면 모양이 뒤집힘 | ⚠→✅ **개선**: 모순이면 "서로 충돌하는 구속: 길이 l0, 길이 bad" 처럼 이름을 알려 줌(관계없는 구속은 빠짐). 길이 40→5→0.5→40 왕복에도 뒤집히지 않고 원래 좌표로 복귀 | `conflictingConstraints`, 2-1·2-2 테스트 |
| 9 | 작은 구멍이 각지고 지름이 줄어듦 (블렌더 기본 32분할) | ✅ 문제 없음: 분할 수가 크기에 맞춰 늘어남(현 오차 ≤ 0.01mm), 정점은 원 위 | 7-1·9-2 테스트, `circularSegments` |
| 10 | 스케치가 엉뚱한 평면·반대쪽에, 돌출 방향 반대 / 조작법 혼란 | ✅ 공유 픽스처로 평면·면·음수 돌출 방향을 두 엔진이 같게 해석. 속성 관리자 미리보기 = 확정 결과(같은 실행기). 조작 안내·표준 보기(Ctrl+1~8)·마우스 방식 선택 추가 | `model-sketch-planes.json`, `model-face-sketch.json`, `solidworks-flow.spec.ts` |

추가로 고친 것
- **겹친 객체를 합치지 않고 내보냄 (7-2)**: 출력 검사가 "겹쳐 있습니다 … 하나로 합치세요" 경고와 [합치기] 수정 버튼을 보여 준다 (`printCheck.ts`).

## 2. 사용감 (솔리드웍스식 조작·화면 + 처음 쓰는 사람 배려)

| 다른 프로그램에서의 불편 | 우리 앱 |
|--------------------------|---------|
| 프로그램마다 마우스 조작이 달라 헷갈림, 트랙패드에선 가운데 버튼이 없음 | 기본 = 솔리드웍스식(가운데 버튼 회전, Ctrl+가운데 이동, 휠 확대). 뷰포트 위 [마우스] 버튼으로 "간편"(왼쪽 회전·오른쪽 이동) 전환, 브라우저에 기억. 화면 아래에 현재 방식 안내 |
| 시점을 잃으면 돌아오기 어려움 | Ctrl+1~7 표준 보기, Ctrl+8 스케치에 수직, F 화면 맞춤, 스페이스 = 보기 방향 메뉴 |
| 스케치를 어디에 그릴지 모름 | 스케치 → 평면이 없으면 모델 크기에 맞춘 기준 평면 3개(이름표 포함)를 띄우고 클릭으로 고름 → 그 평면을 정면으로 |
| 피처 값이 맞는지 확정 전에 알 수 없음 | 속성 관리자: 깊이·방향·각도를 바꾸면 뷰포트에 반투명 미리보기, ✓(Enter) 확정 = 실행 취소 1번, ✕(Esc) 취소 = 원본 그대로 |
| 스케치가 덜 구속된 줄 모름 | 상태 표시줄 "완전 정의 / 불충분 정의 (자유도 N) / 비어 있음", 선 색(파랑 = 덜 구속, 검정 = 완전 정의) |
| 하는 일에 맞는 도구를 찾기 어려움 | 명령 탭(피처·스케치·보기)이 작업에 따라 자동 전환 (그리기·평면 고르기 → 스케치, 피처 확정 대기 → 피처) |

상용 프로그램의 아이콘·로고·화면 디자인은 복사하지 않았다(아이콘은 자체 SVG). 배치와 조작 규칙만 따른다.

## 3. 남은 항목 (다음 단계 후보)

- 4 (오류 위치): 실패한 피처만 트리에 표시하고 마지막 성공 형상 유지 — 지금은 상태 표시줄 메시지 + 원본 유지.
- 3-3 (부모 삭제 연쇄): 면 스케치가 붙은 객체 삭제는 거부되지만, "영향받는 항목 목록" 미리 보기는 없음.
- 5-4 (실행 취소 한계): 200단계 이상에서의 메모리 측정.
- 8-1 (성능): 객체 100개·불리언 깊이 10 장면 응답 시간 측정.
- 9-1 (측정 도구): 두 점·면 사이 거리 측정.
- 쉘(4-2): 쉘 기능을 만들 때 "두께 > 최소 곡률 반지름" 사전 검사를 함께 넣는다.

## 부록: 조사 원문 (분류별 문제·근거·확인 방법)

**출처 확인 범위:** 웹 검색은 여러 번 했지만, 페이지를 직접 여는 WebFetch는 help.solidworks.com과 docs.blender.org가 이 세션의 네트워크 허용 목록에 없어 실패했다. 그래서 아래 URL은 모두 검색 결과에 실제로 나온 페이지이고, 내용은 검색 요약을 근거로 했다. 직접 열어 확인한 페이지는 없다. 원문까지 검증하려면 두 호스트를 세션 네트워크 설정에서 허용해야 한다. 파일은 수정하지 않았다.

---

### 1. 학습 곡선과 UI/UX

1. **문제: 프로그램마다 회전·이동·확대 마우스 조작이 달라 초보자가 헷갈린다.** 관련 프로그램: 여러 CAD 공통(SketchUp, Tinkercad). Shapr3D는 아예 "인기 CAD 10종 흉내 프리셋"을 출시했다.
   - 근거: https://forums.sketchup.com/t/fr-pan-orbit-zoom-control-options-to-match-other-cad-programs/45669.md , https://discourse.shapr3d.com/t/pan-and-orbit-flexibility/14208 , https://forum.edu.cospaces.io/t/curious-if-anyone-else-gets-controls-mixed-up-with-tinkercad/1764
   - **확인 방법:** 처음 실행했을 때 뷰포트에 조작 안내(좌클릭 회전, 우클릭·Shift 이동, 휠 확대)가 보이는지 본다. 노트북 터치패드만으로도 세 동작이 모두 되는지 본다. 홈 뷰나 "전체 맞춤" 버튼으로 길 잃은 시점에서 1클릭에 돌아오는지 본다.

2. **문제: 오류 메시지가 이유와 해결책을 알려주지 않는다.** 예: "Create fillet feature failed / too complicated", What's Wrong 목록 해석이 어렵다. 관련 프로그램: Inventor, SolidWorks.
   - 근거: https://forums.autodesk.com/t5/inventor-forum/unable-to-create-fillet-too-complicated/m-p/9370481 , https://help.solidworks.com/2017/English/SolidWorks/sldworks/HIDD_NEW_WHATS_WRONG.htm
   - **확인 방법:** 엔진 실패를 유발하는 명령을 5종 넣어 본다(필렛 과대, 열린 스케치 돌출, 축을 가로지르는 회전, 두께 0 불리언, 과구속). 그때 OCCT·manifold 원문 예외 대신 한국어로 "무엇이 / 왜 / 어떻게 고칠지(최대 허용값 등)"가 나오는지 본다.

3. **문제: 스케치가 엉뚱한 평면이나 반대쪽 면에 생기고, 돌출이 반대로 나간다.** 관련 프로그램: Inventor. XZ 평면에서 반대편에 스케치가 생기는 사례가 있고, 돌출 방향은 면 법선을 따른다.
   - 근거: https://forums.autodesk.com/t5/inventor-forum/new-sketch-on-xz-plane-puts-me-on-wrong-side/m-p/601061 , https://emea.support.arkance.world/hc/hu/articles/36469041414802-Inventor-2015-Reorient-Sketch , https://forums.autodesk.com/t5/fusion-design-validate-document/extrude-goes-in-wrong-direction/td-p/13757805
   - **확인 방법:** XZ·YZ 평면과 각 이름 면("+X", "-Y", "bottom")에 사각형을 그리고 +10 / -10으로 돌출한다. 미리보기 방향이 결과와 같은지, 음수가 언제나 "재료 안쪽(컷)"인지 픽스처로 고정한다. 스케치 모드에서 평면 이름과 법선 화살표가 보이는지도 본다.

4. **문제: 오류가 난 피처가 무엇인지, 연쇄 실패가 어디서 시작됐는지 찾기 어렵다.** 관련 프로그램: SolidWorks 사용 사례. 전역 변수 하나를 바꾸자 상위 어셈블리 재빌드 오류와 20개 넘는 coincident 메이트 깨짐이 연쇄로 났다.
   - 근거: https://3dswym.3dexperience.3ds.com/question/solidworks-user-forum/major-rebuild-errors-after-updating-global-variable-lesson-6‑72-black-screen-crash_3SslvUokToGH9b7q0oqStA
   - **확인 방법:** 불리언 피연산자를 수정해 실패시킨다. 장면 트리에서 실패한 노드만 표시되는지, 마지막 성공 형상이 유지되는지, 메시지 클릭 시 해당 노드가 선택되는지 본다.

### 2. 스케치와 구속

1. **문제: 과구속·충돌 구속 상태에서 어떤 구속을 지워야 할지 모른다.** 관련 프로그램: SolidWorks. SketchXpert가 해결 후보를 나열해야 할 정도이고, 중복 구속이 있으면 해결이 더 어렵다.
   - 근거: https://help.solidworks.com/2020/english/SolidWorks/sldworks/HIDD_DVE_SKETCH_XPERT.htm , https://help.solidworks.com/2025/English/SolidWorks/Sldworks/c_FAQ_Sketch_Relations.htm
   - **확인 방법:** 사각형에 horizontal을 두 번 걸고 length와 distance가 서로 모순되게 걸어 본다. 솔버가 무한 루프·발산 없이 "과구속"을 보고하는지, 충돌하는 구속을 강조하는지, 마지막 구속이 거부되거나 Undo 1회로 복구되는지 본다. 중복(일관성 있음)과 충돌(모순)이 구분되어 보이는지도 확인한다.

2. **문제: 치수를 바꾸면 스케치가 반대쪽 해로 뒤집힌다.** 탄젠트 호가 180° 돌아가거나 치수 방향이 반전된다. 관련 프로그램: SolidWorks, Inventor.
   - 근거: https://eng-tips.com/threads/dimensions-flipped.165545 , https://3dswym.3dexperience.3ds.com/question/solidworks-user-forum/linear-dimension-in-sketch-is-flipping-automaticaly_TQ5KsueOTuOGrrvyUeh_9Q , https://forums.autodesk.com/t5/inventor-forum/sketch-flips-changes-orientation/m-p/7740274
   - **확인 방법:** tangent와 length를 건 폴리곤에서 length를 작게→크게→작게 반복하고 거리를 0 근처로 지나가게 한다. 해가 직전 해에서 가장 가까운 쪽으로 이어지는지 본다(직전 좌표를 초기값으로 쓰는지). 원래 값으로 돌리면 원래 형상이 그대로 나오는지 본다.

3. **문제: 참조하던 대상이 바뀌거나 삭제되면 구속·치수가 "매달린(dangling)" 상태가 된다.** 관련 프로그램: SolidWorks. 자동 복구 기능이 있지만 외부 참조는 수동으로 고쳐야 한다.
   - 근거: https://help.solidworks.com/2025/English/WhatsNew/c_wn2025_sketch_repair_relations.htm , https://help.solidworks.com/2025/English/SolidWorks/Sldworks/HIDE_SKETCH_EXTREFS_FAIL.htm
   - **확인 방법:** 구속이 걸린 꼭짓점이나 선을 삭제하면 관련 구속도 같은 명령 안에서 함께 지워지거나 경고가 뜨는지 본다. Undo로 원상복구되는지 본다. `.ai3d` 마이그레이션에서 존재하지 않는 엔티티 ID를 참조하는 구속을 넣은 파일이 크래시 없이 열리는지 본다.

4. **문제: 눈에 안 보이는 틈, 중복선, 떠 있는 엔티티 때문에 "열린 윤곽"이 되어 돌출·회전이 실패한다.** 관련 프로그램: SolidWorks. Check Sketch for Feature, Repair Sketch가 따로 필요하고, DXF 같은 가져온 형상에서 특히 잦다.
   - 근거: https://store.trimech.com/blog/solidworks-sketch-tool-check-sketch-for-feature , https://www.cati.com/blog/tools-to-check-and-repair-sketchs/ , https://3dswym.3dexperience.3ds.com/question/solidworks-user-forum/can-t-extrude-sketch-open-contour_RmPh0TrqR9ORy3eq45JtJg
   - **확인 방법:** 폴리곤에서 첫 점과 끝 점이 1e-4mm만큼 떨어진 경우, 같은 점이 연속으로 중복된 경우, 길이 0인 변, 자기교차(8자형)를 각각 만든다. 그다음 돌출을 실행했을 때 엔진에 넘기기 전에 검증해 "어느 변/점이 문제인지"를 표시하는지 본다. 닫힌 영역이 음영으로 표시되면 SolidWorks 2017처럼 좋은 즉시 피드백이 된다.

5. **문제: 덜 구속된 스케치가 다른 편집 후 예상치 않게 움직인다.** 관련 프로그램: Inventor. 튜토리얼이 "Fully Constrained" 상태를 꼭 확인하라고 권한다.
   - 근거: https://www.trainingtutorial.com/inventor-tips-and-tricks/tat33-prevent-lost-geometry-references-with-autodesk-inventor/
   - **확인 방법:** 남은 자유도가 0보다 큰 스케치를 돌출한 뒤 다른 치수를 바꿔도, 고정되지 않은 점이 솔버 때문에 엉뚱하게 이동하지 않는지 본다(최소 이동 원칙). 남은 자유도 표시가 모든 스케치 모드에서 보이는지도 본다.

### 3. 재빌드와 피처 트리

1. **문제: 위상 이름 문제(topological naming).** 앞 피처를 수정하면 면·모서리 이름이 바뀌어(예: Face13→Face14) 그 면 위의 스케치나 필렛 참조가 깨진다. 관련 프로그램: FreeCAD 위키에 OCCT 계열의 일반 문제로 정리되어 있다. SolidWorks에도 "Fillet is missing edges"가 있다.
   - 근거: https://wiki.freecad.org/Topological_naming_problem/en , https://help.solidworks.com/2020/English/WhatsNew/t_repair_missing_references.htm , https://3dswym.3dexperience.3ds.com/question/solidworks-user-forum/warning-fillet-is-missing-x-edges-when-trying-to-edit-feature_5G0UXUXkSwah7L0GY3aGLA
   - **확인 방법:** 우리 앱은 면 참조를 의미 이름("top", "+X", 돌출 "end")으로 하니 구조적으로 유리하다. 그래도 다음을 검증한다. ① 박스 "top"에 스케치한 뒤 박스 높이를 바꾸거나 회전시켜도 스케치가 따라가는지. ② 돌출 "end" 면에 스케치한 뒤 돌출 길이를 음수로 뒤집었을 때 "end"가 어디로 해석되는지(정의되어 있고 두 엔진이 같은지). ③ 참조한 객체를 삭제하면 명확한 오류가 나는지, 조용히 원점으로 가지 않는지.

2. **문제: 예전에 만든 필렛·챔퍼가 치수를 줄이면 너무 커져 재빌드 실패가 된다.** 관련 프로그램: SolidWorks.
   - 근거: https://forum.solidworks.com/thread/73648 , https://help.solidworks.com/2018/english/SolidWorks/fworks/IDS_FW_DIAGMSG_FILLET_RADIUS_MORE.htm
   - **확인 방법:** 20mm 박스에 R4 필렛을 준 뒤 박스 높이를 6mm로 줄인다. 이때 박스 편집이 막히지 않는지, 필렛만 실패로 표시되는지(또는 반지름이 자동으로 줄어드는지), 원래 크기로 돌리면 필렛이 복구되는지 본다.

3. **문제: 부모(참조 대상)를 지우거나 억제하면 자식 피처가 연쇄로 깨진다.** 빈 스케치 하나를 지웠는데 작업평면이 깨진 사례가 있다. 관련 프로그램: Inventor.
   - 근거: https://forums.autodesk.com/t5/inventor-forum/deleting-an-empty-sketch-that-has-no-children-messes-up-a-bunch/m-p/12748812
   - **확인 방법:** 불리언 피연산자, 면에 붙은 스케치의 기준 객체, 관통홀 대상 객체를 각각 삭제한다. 이때 영향받는 항목 목록이 미리 경고로 나오는지, Undo 한 번에 전부 복구되는지 본다.

4. **문제: 피처 하나(필렛, 랩)가 재빌드 시간의 절반~80%를 차지하는데 사용자는 원인을 모른다.** 관련 프로그램: SolidWorks(Feature Statistics).
   - 근거: https://knowledge.cadimensions.com/knowledge/why-is-my-part-taking-so-long-to-rebuild , https://www.javelin-tech.com/blog/2022/11/evaluate-and-improve-solidworks-performance/
   - **확인 방법:** 형상 키 캐시 덕분에 한 객체를 수정했을 때 다른 객체가 재계산되지 않는지 본다(엔진 호출 횟수를 테스트로 계측). 개발 로그에 객체별 재계산 시간이 남는지도 본다.

### 4. 형상 커널 실패

1. **문제: 필렛 반지름이 모서리나 인접 면 대비 너무 크면 실패한다.** 1.99mm는 되는데 2mm는 실패하는 경계 사례도 있다. 관련 프로그램: SolidWorks, Inventor, Onshape.
   - 근거: https://forums.autodesk.com/t5/inventor-forum/fillet-radius-problems-inventor-professional-2021/m-p/9477929 , https://forums.autodesk.com/t5/inventor-forum/inventor-2019-creating-a-fillet-failed/m-p/8387500 , https://forum.onshape.com/discussion/7483/the-current-fillet-radius-produces-invalid-geometry
   - **확인 방법:** 10×20×30 박스에 필렛·챔퍼 반지름을 4.99 / 5.0 / 5.01로 준다(가장 짧은 변의 절반 근처). 두 엔진의 결과가 같은지(성공·실패 경계 일치), 실패 시 원본이 유지되는지, "최대 약 4.99mm" 같은 메시지가 나오는지 본다. 공유 픽스처로 만든다.

2. **문제: 쉘 두께가 최소 곡률반경보다 크면 쉘이 실패한다.** 숨은 0.057mm 곡률이 원인이었던 사례가 있다. 관련 프로그램: SolidWorks.
   - 근거: https://help.solidworks.com/2019/english/SolidWorks/sldworks/hide_shell_model_fail.htm , https://grabcad.com/questions/shell-error-thickness-value-is-greater-than-minimum-radius-of-curvature-how-to-overcome-this
   - **확인 방법:** 쉘 기능이 생기면 필렛 박스에 R보다 큰 두께로 쉘을 걸어 본다. 지금은 "too thin" 프린트 검사가 같은 계열이니 벽 두께 검출 정확도를 확인한다.

3. **문제: 두께 0 형상(zero-thickness).** 컷이 기존 구멍에 접하거나, 모서리끼리만 맞닿거나, 면이 겹치면 non-manifold 솔리드가 된다. 관련 프로그램: SolidWorks.
   - 근거: https://help.solidworks.com/2017/English/SolidWorks/sldworks/HIDE_NON_MANIFOLD.htm , https://www.goengineer.com/en-us/blog/solidworks-zero-thickness-error
   - **확인 방법:** ① 두 박스가 면을 정확히 공유하는 union. ② 모서리 하나만 공유하는 union. ③ 컷 원통이 박스 옆면에 정확히 접하는 cut. ④ 컷 깊이가 정확히 박스 높이와 같은 관통 cut(같은 평면 면). 이 4가지 픽스처를 OCCT와 manifold 엔진 양쪽에 돌려 결과가 일치하는지, 내보낸 STL이 watertight인지 본다.

4. **문제: 불리언에서 같은 평면 면이나 겹친 형상이 들어가면 빠른 솔버가 실패한다.** 관련 프로그램: Blender. Float 솔버는 겹침을 지원하지 않고, Manifold 솔버는 non-manifold 입력에서 아예 동작하지 않는다.
   - 근거: https://www.blender.org/manual/en/modeling/modifiers/generate/booleans.html , https://docs.blender.org/api/latest/bpy.types.BooleanModifier.html
   - **확인 방법:** 브라우저 엔진이 manifold-3d를 쓰므로 입력은 항상 닫힌 메시여야 한다. 스케치 돌출이나 회전 결과(특히 축에 닿는 회전)가 manifold 생성자에서 거부되는 경우가 있는지 퍼즈 테스트한다. 거부되면 메시지가 나오는지도 본다.

5. **문제: 회전 프로파일이 열려 있거나, 자기교차하거나, 회전축을 가로지르면 실패한다.** 관련 프로그램: SolidWorks("The sketch is open, self-intersecting, or intersects the centerline").
   - 근거: https://mechanical-engineering.com/fix-solidworks-error-self-intersecting/ , https://3dswym.3dexperience.3ds.com/question/solidworks-user-forum/revolved-cut-sketch-is-open-self-intersects-or-intersects-the-centerline_Ee44Zxk6Rhy13XaC7pPXTw
   - **확인 방법:** 다음 3가지로 회전시켜 본다. ① 축을 가로지르는 원. ② 변 하나가 축 위에 정확히 놓인 반원(정상 케이스). ③ 축에 한 점만 닿는 삼각형. ①은 사전 검증으로 막고, ②③은 두 엔진 모두 non-manifold 없이 성공하는지 본다.

6. **문제: 미세한 모서리·면과 허용오차 문제.** 숨은 아주 작은 면이 쉘·필렛 실패를 일으킨다. 관련 프로그램: SolidWorks.
   - 근거: https://help.solidworks.com/2017/english/SolidWorks/sldworks/c_Shell_Exceptions.htm
   - **확인 방법:** 0.001mm 길이 변이 있는 폴리곤을 돌출하거나, 1e-6mm 어긋난 두 박스를 union한다. 엔진이 크래시나 무한대기 없이 끝나는지, 프린트 검사가 미세 특징을 경고하는지 본다.

### 5. 데이터 안전과 안정성

1. **문제: 크래시로 작업을 잃는다.** Inventor에는 기본 자동저장이 없어 오래된 아이디어 요청이 이어지고 있고, 크래시 후 하루 전 저장본으로 돌아간 사례가 있다. SolidWorks 자동복구는 한 번도 저장 안 한 파일은 보호하지 않고, 복구 탭이 안 뜨기도 한다.
   - 근거: https://forums.autodesk.com/t5/inventor-ideas/autosave/idi-p/12731437/highlight/true/page/4 , https://forums.autodesk.com/t5/inventor-forum/inventor-reverts-back-to-older-saved-data-after-crash/td-p/13396654 , https://www.cati.com/?p=128803 , https://3dswym.3dexperience.3ds.com/question/solidworks-user-forum/auto-recover-not-triggering-after-crash-despite-proper-settings-solidworks-2025_xjT1WpV2R2yITX_nQx328g
   - **확인 방법:** 저장한 적 없는 새 프로젝트에서 명령 몇 개를 실행한 뒤 탭을 강제로 닫거나 프로세스를 kill한다. 다시 열면 복구를 제안하는지 본다(localStorage/IndexedDB 또는 로컬 백엔드). 웹과 Tauri 양쪽에서 확인한다.

2. **문제: 저장 도중 실패하면 파일이 손상된다.** SolidWorks는 "Open and Repair"와 백업 폴더를 따로 권한다. Inventor 포럼에는 강제 저장이 손상을 부를 수 있다는 의견이 있다.
   - 근거: https://solidsolutions.co.uk/blog/2023/04/how-to-recover-SOLIDWORKS-files-after-a-crash , https://forums.autodesk.com/t5/inventor-forum/autosave-option-in-inventor/m-p/8639725
   - **확인 방법:** `.ai3d` 저장을 임시파일에 쓴 뒤 rename하는 원자적 방식으로 하는지 본다. 잘린 JSON이나 알 수 없는 명령 타입이 든 파일을 열 때 앱이 죽지 않고 구체적인 오류와 함께 원본을 보존하는지 본다.

3. **문제: 버전 간 파일 비호환.** Inventor는 2년 이상 새 파일을 못 열고 이전 형식 저장도 없다. SolidWorks는 "Future Version" 오류가 나며, 2024 이전에는 하위 버전 저장이 불가했다.
   - 근거: https://help.autodesk.com/cloudhelp/2024/ENU/Inventor-Help/files/GUID-489A3E1D-EB3E-4468-9592-F2EAD0E584DD.htm , https://help.autodesk.com/cloudhelp/2026/ENU/Inventor-Help/files/GUID-88E98285-7D43-436D-BCFF-BB49EDB44002.htm , https://www.goengineer.com/blog/open-future-version-files-in-solidworks
   - **확인 방법:** 각 과거 스키마 버전의 픽스처 파일이 최신 앱에서 열리는지(마이그레이션 테스트) 본다. 더 새 버전의 `.ai3d`를 열 때 "앱을 업데이트하세요"와 함께 읽기 전용으로라도 표시되는지, 무시·손상 없이 처리되는지 본다. 웹과 Windows가 같은 파일을 왕복할 수 있는지도 본다.

4. **문제: Undo 한계와 Undo가 안 되는 작업.** Blender는 편집 모드 Undo가 객체 모드와 분리되어 있고, 다른 객체를 편집하면 기록이 사라진다. 단계 수와 메모리 제한도 있다.
   - 근거: https://wiki.blender.jp/Doc:2.6/Manual/Vitals/Undo_and_Redo , https://projects.blender.org/blender/blender/issues/88010
   - **확인 방법:** 스케치 편집, 구속 추가, 필렛, 내보내기 설정, AI 명령, 파일 불러오기 각각에서 Undo/Redo가 동작하는지 표로 점검한다. 명령 200개 이상에서 메모리 증가와 성능을 측정하고, 한계에 도달하면 사용자에게 알리는지 본다.

### 6. 단위, 스케일, 좌표

1. **문제: STL에는 단위가 없다.** inch로 내보내면 1/25.4, Blender 기본 m 단위면 1/1000 크기로 슬라이서에 들어온다. 관련 프로그램: SolidWorks, Inventor, Blender.
   - 근거: https://forums.autodesk.com/t5/inventor-forum/units-change-when-i-export-to-stl-file/m-p/11984203/highlight/true , https://3dswym.3dexperience.3ds.com/question/solidworks-user-forum/stl-export-scaling-issues_MC6FJnlUQs-gh6-iaOI1Kw , https://developer.blender.org/T43580
   - **확인 방법:** 20mm 큐브를 STL·3MF로 내보낸 뒤 바운딩박스가 정확히 20인지 자동 테스트한다. 3MF는 `unit="millimeter"` 속성이 들어가는지 본다.

2. **문제: glTF는 미터 단위이자 Y-up이다.** mm 값을 그대로 쓰면 1000배로 커지고, Z-up 모델은 90° 누워 보인다.
   - 근거: https://docs.cadexchanger.com/sdk/sdk_format_gltf_page.html , https://discourse.slicer.org/t/scale-model-in-gltf/31639 , https://github.com/RobotLocomotion/drake-blender/issues/39
   - **확인 방법:** GLB 내보내기에서 ① 0.001 스케일 변환(또는 정점 변환)이 들어가는지, ② Z-up→Y-up 회전이 적용되는지 본다. 내보낸 GLB를 three.js GLTFLoader나 외부 뷰어로 다시 읽었을 때 바닥이 아래에 있고 크기가 0.02m인지 확인한다.

3. **문제: 축 변환 옵션이 혼란스럽다.** Blender STL 내보내기의 Forward/Up 축 설정과 스케일 옵션이 그 예다. 관련 프로그램: Blender.
   - 근거: https://www.blender.org/manual/en/files/import_export/stl.html
   - **확인 방법:** STL·3MF·STEP 내보내기에서 Z-up을 그대로 유지하는지 본다. 슬라이서 기준으로 "바닥면 = 원점 높이 0"인 객체가 베드에 눕지 않고 서 있는지 픽스처로 확인한다.

4. **문제: 적용되지 않은 스케일 때문에 모디파이어(베벨, 솔리디파이) 결과가 왜곡된다.** 관련 프로그램: Blender.
   - 근거: https://devtalk.blender.org/t/modifiers-improvements/9788/21 , https://devtalk.blender.org/t/mesh-tools-and-non-uniformly-scaled-objects/2580
   - **확인 방법:** 우리 앱에 transform scale이 있다면, 비균일 스케일 박스에 필렛 2mm를 줬을 때 실제 결과가 2mm인지 본다(필렛을 스케일 전에 적용하는지 후에 적용하는지 정의하고 두 엔진에서 일치하는지).

### 7. 내보내기와 3D 프린팅

1. **문제: 곡면 테셀레이션이 거칠어 프린트에 각이 보인다.** SolidWorks "Fine"으로도 각진 사례가 있고, 슬라이서는 해상도를 복구하지 못한다. 반대로 너무 세밀하면 파일이 거대해진다.
   - 근거: https://help.solidworks.com/2021/English/SolidWorks/Sldworks/HIDD_STL.htm , https://forum.formlabs.com/t/stl-file-resolution-for-0-050-and-0-100-mm-prints/36589 , https://redlib.hackliberty.org/r/3Dprinting/comments/1j8mwrh/printed_a_cylinder_came_out_faceted_any_idea_why
   - **확인 방법:** 지름 3mm와 100mm 원통을 내보내 현 오차(chord deviation)가 설정값 이하인지 본다(작은 구멍도 충분한 분할). OCCT와 manifold 엔진의 분할 수가 비슷한지, 품질 프리셋이 있는지 본다.

2. **문제: 겹치거나 맞닿은 여러 바디가 별도 셸로 내보내져 슬라이서 문제를 일으킨다.** 관련 프로그램: Inventor 및 공통.
   - 근거: https://forums.autodesk.com/t5/fusion-360-design-validate/combining-bodies-for-3d-print/td-p/9699643 , https://www.hubs.com/knowledge-base/fixing-most-common-stl-file-errors/ , https://docs.ntop.com/community/packages/natalie-scala/multi-material-printing-export
   - **확인 방법:** 겹친 박스 두 개(불리언 없음)를 STL로 내보낼 때 "겹친 객체가 있습니다. 합칠까요?" 같은 경고가 나오는지 본다. 3MF에서는 객체별로 분리되는지 본다.

3. **문제: non-manifold나 열린 메시는 프린트할 때 구멍이 된다.** 관련 프로그램: Blender. Select Non-Manifold를 쓰거나, 지금은 별도 확장으로 빠진 3D Print Toolbox가 필요하다.
   - 근거: https://projects.blender.org/blender/blender-addons/issues/104540 , https://docs.blender.org/manual/ko/3.2/addons/mesh/3d_print_toolbox.html , https://all3dp.com/2/non-manifold-edges/
   - **확인 방법:** 모든 내보내기 전에 엣지마다 인접 면이 정확히 2개인지 자동 검사하고, 실패하면 프린트 전 검사 패널에 표시되는지 본다(4장 3번 픽스처 재사용).

4. **문제: 뒤집힌 법선으로 생긴 "안팎이 뒤집힌" 메시.** 관련 프로그램: Blender. Recalculate Normals가 복잡한 형상에서는 실패하기도 한다.
   - 근거: https://projects.blender.org/blender/blender/issues/46648 , https://projects.blender.org/blender/blender/issues/43848
   - **확인 방법:** 음수 스케일(미러) 객체, 음수 돌출, 회전(축 방향 반대)으로 만든 객체를 STL로 내보낸다. 부호 있는 부피가 양수인지, 모든 삼각형이 바깥을 향하는지 테스트한다.

5. **문제: 평면이 아닌 n-gon이 STL 삼각화 과정에서 형상을 바꾼다.** 관련 프로그램: Blender.
   - 근거: https://blenderartists.org/t/topology-for-3d-printing-must-i-avoid-triangles-and-n-gones-or-not/641340 , https://developer.blender.org/T32304
   - **확인 방법:** 오목 다각형(별 모양, L자) 스케치를 돌출하고 STL로 내보낸다. 뚜껑 면의 삼각형이 바깥으로 삐져나오지 않는지, 부피가 해석값과 일치하는지 본다(earcut 오목 처리).

### 8. 성능, 라이선스, 비용(참고)

1. **문제: 큰 모델이나 복잡한 피처에서 재빌드가 느리다.** 40~60초 걸린 파트 사례가 있다. 관련 프로그램: SolidWorks.
   - 근거: https://forum.solidworks.com/thread/232447 , https://www.cati.com/blog/improving-large-assembly-performance-part-2/
   - **확인 방법:** 객체 100개, 불리언 깊이 10 장면에서 파라미터 하나를 바꿨을 때 응답 시간을 잰다(예: 1초 미만). 계산 중에도 UI가 멈추지 않는지(Web Worker) 본다.

2. **문제: 비용과 제약.** SolidWorks Standard는 약 $3,995에 연 $1,295 유지비라는 포럼 게시물이 있다. Maker 라이선스는 워터마크 등 제한이 있다. Fusion 개인판은 편집 가능 문서 수 제한과 클라우드 의존이 있다.
   - 근거: https://forums.autodesk.com/t5/inventor-ideas/hobbyist-maker-pricing-options/idi-p/12306685 , https://community.carbide3d.com/t/autodesk-fusion-360-changing-hobbyist-licensing-what-other-tools-should-be-considered/25932/6
   - **확인 방법:** 계정·네트워크 없이 모든 편집과 내보내기가 되는지 본다(offline E2E가 이미 강제함). 프로젝트 수나 기능에 인위적 제한이 없는지 본다.

### 9. Blender 특유의 모델링 문제

1. **문제: 정확한 치수 입력이 어렵다.** Blender 매뉴얼도 정밀 모델링에는 별도 애드온(PDT)이 필요하다고 소개하고, 포럼에서는 정밀 기계 부품에 CAD를 권한다.
   - 근거: https://www.blender.org/manual/en/addons/3d_view/precision_drawing_tools/introduction.html , https://blenderartists.org/t/how-is-blender-evolving-with-regard-to-3d-printing/1192287
   - **확인 방법:** 모든 치수, 위치, 회전 필드가 숫자 입력(수식 `10+2.5` 포함)을 지원하는지 본다. 드래그 편집에도 스냅(1mm/0.1mm)이 있는지, 두 점이나 면 사이 거리 측정 도구가 있는지 본다.

2. **문제: Blender 기본 원통 분할(32)이 작은 구멍을 각지게, 그리고 실제보다 작게 만든다.** 내접 다각형이라 지름이 줄어든다.
   - 근거: https://dr-lex.be/3d-printing/step-versus-mesh.html , https://redlib.hackliberty.org/r/3Dprinting/comments/1j8mwrh/printed_a_cylinder_came_out_faceted_any_idea_why
   - **확인 방법:** 브라우저 엔진(manifold)에서 지름 5mm 관통홀을 만들고 메시상 최소 지름을 측정한다. 공차 허용치 이내인지, 원 분할이 크기에 따라 적응하는지 본다.

3. **문제: Boolean 후 non-manifold 결과와 거대한 리메시.** 관련 프로그램: Blender.
   - 근거: https://blenderartists.org/t/5-basic-cubes-with-4-holes-somehow-non-manifold-and-a-huge-remesh/1168939
   - **확인 방법:** 박스 하나에서 원통 4개를 빼는 불리언 후 manifold 여부와 삼각형 수 증가율을 점검한다.

4. **문제: 3D Print Toolbox가 기본 기능에서 빠져 확장으로 따로 설치해야 하고, 씬 단위 설정에 따라 내보내기 스케일이 틀리는 버그가 있었다.** 관련 프로그램: Blender.
   - 근거: https://projects.blender.org/blender/blender-addons/issues/104540 , https://developer.blender.org/T43580
   - **확인 방법:** 프린트 전 검사가 기본 내장이고 내보내기 전에 자동으로 실행(또는 요약 표시)되는지 본다.

---

### 가장 우선 확인할 10개 (프린트용 부품을 만드는 초보자 기준 영향도 순)

1. **STL·3MF 단위와 크기:** 20mm 큐브를 내보내면 정확히 20mm인지, 3MF에 mm 단위가 명시되는지. (6-1)
2. **GLB의 m 단위 변환과 Y-up 변환:** 1000배 크기나 90° 누움 문제가 없는지. (6-2)
3. **내보낸 메시의 watertight와 법선:** 겹친 면·모서리, 접하는 컷, 같은 평면 관통 컷 픽스처를 두 엔진 모두 manifold로, 부피는 양수로 내보내는지. (4-3, 7-3, 7-4)
4. **필렛·챔퍼 반지름 과대:** 실패해도 원본이 유지되고, 최대 허용값을 알려주는 한국어 메시지가 나오며, 두 엔진의 성공·실패 경계가 일치하는지. (4-1)
5. **치수를 줄였을 때 기존 필렛·불리언·면 스케치가 깨지지 않거나, 깨진 항목만 명확히 표시되는지.** 원래 값으로 돌리면 복구되는지. (3-1, 3-2)
6. **크래시와 탭 종료 복구:** 저장한 적 없는 프로젝트도 복구되는지, 저장이 원자적인지. (5-1, 5-2)
7. **열린·자기교차·길이 0 스케치를 엔진 호출 전에 검증하는지:** 문제 위치를 표시하는지, 축을 가로지르는 회전을 차단하는지. (2-4, 4-5)
8. **과구속·충돌 구속:** 솔버가 멈추지 않고 충돌하는 구속을 지목하는지, 치수 변경 시 해가 뒤집히지 않는지. (2-1, 2-2)
9. **곡면 테셀레이션 품질:** 작은 구멍도 충분히 둥글고 지름이 줄지 않는지(두 엔진 일치). (7-1, 9-2)
10. **스케치 평면·면과 돌출 방향:** 모든 평면과 이름 면에서 미리보기와 결과가 같고, 음수 = 컷 방향이 일관되는지. 마우스 조작 안내와 홈 뷰가 있는지. (1-3, 1-1)
