#!/bin/bash
#
# deploy.sh — GitHub Pages 배포 (버전 범프 + 커밋 + 푸시)
#
# 하는 일:
#   1. 새 버전 V 생성 (현재 시각 epoch)
#   2. assets/version.json 갱신 (레포 기존 포맷 유지: 숫자 or 문자열)
#   3. index.html의 window.__V 갱신
#   4. 모든 정적 import의 ?v=<old> → ?v=<new> 교체 (브라우저/홈화면 캐시 무효화)
#   5. git add -A → commit → push (Pages 자동 재배포)
#
# 사용법: ./deploy.sh ["커밋 메시지"]
# Windows에서는 Git Bash 또는 WSL에서 실행.
#
set -euo pipefail

# 반드시 레포 루트에서 실행 (파괴적 명령 안전장치)
cd "$(dirname "$0")" || exit 1
[ -f assets/version.json ] || { echo "assets/version.json 없음. 레포 루트에서 실행하세요." >&2; exit 1; }
[ -f index.html ] || { echo "index.html 없음. 레포 루트에서 실행하세요." >&2; exit 1; }

V=$(date +%s)
OLD_V=$(grep -o '[0-9]\+' assets/version.json | head -1)
[ -n "$OLD_V" ] || { echo "기존 버전을 읽지 못함" >&2; exit 1; }

# version.json 포맷 유지 (숫자 vs 문자열)
if grep -q '"v"[[:space:]]*:[[:space:]]*"[0-9]*"' assets/version.json; then
  printf '{"v":"%s"}' "$V" > assets/version.json
  JS_V="\"$V\""
else
  printf '{"v":%s}' "$V" > assets/version.json
  JS_V="$V"
fi

# index.html의 window.__V 갱신
sed -i "s/window\.__V=\"\?[0-9]*\"\?/window.__V=${JS_V}/" index.html

# 추적 중인 모든 파일의 ?v=<old> 교체 (.git 제외, git grep이 추적 파일만 반환)
if git grep -l "?v=${OLD_V}" -- . 2>/dev/null; then
  git grep -l "?v=${OLD_V}" -- . | while IFS= read -r f; do
    sed -i "s/?v=${OLD_V}/?v=${V}/g" "$f"
  done
fi

# 커밋 & 푸시
MSG="${1:-배포 v$V}"
git add -A
if git diff --cached --quiet; then
  echo "변경 없음. 푸시할 것이 없습니다."
else
  git commit -m "$MSG"
  git push
  echo "배포 완료: v$V"
fi
