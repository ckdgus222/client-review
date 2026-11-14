#!/usr/bin/env bash
# 탈퇴 처리나 글 속 개인정보 삭제 같은 손작업의 앞뒤에 돌린다(docs/deploy.md 정할 것 7).
#   deploy/maintenance.sh start   점검 표시(manual)를 남기고 api를 멈춘다
#   deploy/maintenance.sh end     api를 켜고 응답을 확인한 뒤 표시를 지운다
# 표시가 있는 동안에는 백업과 업데이트가 돌지 않아서, 손작업 중에 api가 켜지거나 반쯤 바뀐 DB가 백업되지 않는다.
set -euo pipefail

if [ "$#" -ne 1 ] || { [ "$1" != start ] && [ "$1" != end ]; }; then
    echo "사용법: $0 start|end" >&2
    exit 1
fi

source "$(dirname "$(readlink -f "$0")")/lib.sh"
take_lock
marker=$(read_marker)

if [ "$1" = start ]; then
    if [ -n "$marker" ]; then
        echo "이미 점검 중이에요(표시: $marker)" >&2
        exit 1
    fi
    # 표시를 먼저 남긴다. api를 멈춘 뒤 끊겨도 백업이 api를 다시 켜지 않는다.
    echo manual > "$MARKER_FILE"
    docker compose stop api
    echo "api를 멈췄어요. 손작업을 마치면 $0 end 를 돌려 주세요"
    exit 0
fi

if [ "$marker" != manual ]; then
    echo "손작업 표시(manual)가 없어요(표시: ${marker:-없음})" >&2
    exit 1
fi
docker compose start api
# 표시는 api가 응답한 뒤에 지운다. 먼저 지우면 켜기에 실패했을 때 api가 꺼진 채 다시 켤 길이 없다.
if ! wait_for_api; then
    echo "api가 응답하지 않아요. docker compose logs api 로 원인을 고친 뒤 $0 end 를 다시 돌려 주세요" >&2
    exit 1
fi
rm "$MARKER_FILE"
echo "api를 켰고 점검 표시를 지웠어요"
