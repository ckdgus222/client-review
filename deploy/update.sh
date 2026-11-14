#!/usr/bin/env bash
# 새 커밋을 받아 컨테이너를 다시 만든다(docs/deploy.md 정할 것 11).
#   deploy/update.sh           서비스가 모두 돌고 있을 때만 시작한다
#   deploy/update.sh --retry   실패한 업데이트를 고친 커밋으로 다시 한다(표시가 update일 때만)
set -euo pipefail

if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != --retry ]; }; then
    echo "사용법: $0 [--retry]" >&2
    exit 1
fi

source "$(dirname "$(readlink -f "$0")")/lib.sh"
take_lock
marker=$(read_marker)

if [ "${1:-}" = --retry ]; then
    if [ "$marker" != update ]; then
        echo "실패한 업데이트가 없어요(표시: ${marker:-없음})" >&2
        exit 1
    fi
else
    if [ -n "$marker" ]; then
        echo "점검 중이라 업데이트하지 않아요(표시: $marker)" >&2
        exit 1
    fi
    # up -d는 멈춰 둔 서비스도 켠다. 일부러 멈춘 것을 모르고 켜지 않게, 하나라도 꺼져 있으면 바꾸기 전에 그만둔다.
    for service in db api nginx; do
        if [ -z "$(docker compose ps -q --status running "$service")" ]; then
            echo "꺼진 서비스가 있어 업데이트하지 않아요: $service" >&2
            exit 1
        fi
    done
    # 컨테이너를 바꾸기 전에 표시를 남긴다. 어디서 실패하거나 끊겨도 표시가 남아 --retry로 다시 할 수 있다.
    echo update > "$MARKER_FILE"
fi

report_failure() {
    if [ "$?" -ne 0 ]; then
        alert "업데이트 실패: 원인을 고친 커밋을 올린 뒤 deploy/update.sh --retry 를 돌려 주세요"
    fi
}
trap report_failure EXIT

git pull --ff-only
docker compose up -d --build
# api만이 아니라 소개 페이지(nginx가 직접 내준다)도 본다.
if ! wait_for_api || ! docker compose exec -T nginx wget -qO /dev/null -T 5 http://127.0.0.1/; then
    echo "응답 확인에 실패했어요. docker compose logs api nginx 를 확인하세요" >&2
    exit 1
fi
rm "$MARKER_FILE"
echo "업데이트를 마쳤어요"
