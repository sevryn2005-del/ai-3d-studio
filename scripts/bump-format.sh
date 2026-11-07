#!/bin/bash
# 형식 버전 올리기 (프로젝트 .ai3d · 모델 schemaVersion): scripts/bump-format.sh OLD NEW "변경 설명"
# 상수(Zod·Pydantic·projectFile)·마이그레이션 블록·시험 기대값을 한꺼번에 바꾼다. 새 필드 자체는 따로 고친 뒤 npm run schema:export
set -e
O=$1; N=$2; DESC=$3
R="$(cd "$(dirname "$0")/.." && pwd)"
cd $R/frontend
sed -i "s/export const MODEL_SCHEMA_VERSION = $O;/export const MODEL_SCHEMA_VERSION = $N;/" src/cad/commandTypes.ts
sed -i "s/    schemaVersion: Literal\[$O\]/    schemaVersion: Literal[$N]/" ../backend/app/cad/commands.py
sed -i "s/export const PROJECT_FORMAT_VERSION = $O;/export const PROJECT_FORMAT_VERSION = $N;/" src/features/projects/projectFile.ts
sed -i "s/ \* 읽기는 1~$O 모두, 쓰기는 항상 최신($O)./ * - $N: + $DESC. v$O 내용은 그대로 유효\n * 읽기는 1~$N 모두, 쓰기는 항상 최신($N)./" src/features/projects/projectFile.ts
python3 - "$O" "$N" "$DESC" <<'PY'
import sys
O,N,D=sys.argv[1],sys.argv[2],sys.argv[3]
p='src/features/projects/projectFile.ts'
s=open(p).read()
P=str(int(O)-1)
old=f"model.schemaVersion === {P} ? {{ ...model, schemaVersion: MODEL_SCHEMA_VERSION }} : model;\n    file = {{ ...file, formatVersion: {O}, model: migrated }};\n  }}"
assert old in s, old
new=f"model.schemaVersion === {P} ? {{ ...model, schemaVersion: {O} }} : model;\n    file = {{ ...file, formatVersion: {O}, model: migrated }};\n  }}\n  if ((file.formatVersion as number) < {N}) {{\n    // v{O} → v{N}: {D}(선택 항목)만 추가 → 내용 그대로, 버전만 올린다\n    const model = file.model as Record<string, unknown> | undefined;\n    const migrated = model && typeof model === 'object' && model.schemaVersion === {O} ? {{ ...model, schemaVersion: MODEL_SCHEMA_VERSION }} : model;\n    file = {{ ...file, formatVersion: {N}, model: migrated }};\n  }}"
s=s.replace(old,new)
open(p,'w').write(s)
PY
sed -i "s/schemaVersion: $O, units/schemaVersion: $N, units/g" src/components/Viewport/CadObjectMesh.tsx src/features/projects/projectFile.test.ts src/features/engine/browser/geometry.ts src/features/engine/occt/occtGeometry.ts src/features/backend/renderMesh.ts src/features/backend/renderMesh.test.ts
sed -i "s/formatVersion).toBe($O)/formatVersion).toBe($N)/; s/formatVersion: $O, name/formatVersion: $N, name/; s/schemaVersion: $O, sketches: \[\]/schemaVersion: $N, sketches: []/" e2e/home.spec.ts e2e/modeling.spec.ts e2e/sketch-extrude.spec.ts e2e/legacy-project.spec.ts e2e/project.spec.ts
F=$(grep -rl "\"schemaVersion\": $O" ../backend/tests ../backend/evals | grep -v pyc || true)
[ -n "$F" ] && sed -i "s/\"schemaVersion\": $O/\"schemaVersion\": $N/g" $F
grep -rn "toBe($O)\|schemaVersion: $O\b\|\"schemaVersion\": $O" src e2e ../backend/tests ../backend/evals ../backend/app | grep -v pyc | grep -v "schemaVersion === " || echo "bump $O→$N 완료"
