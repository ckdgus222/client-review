# 운영 스크립트(backup, update, restore, maintenance)가 함께 쓰는 것(docs/deploy.md 정할 것 7).
# 따로 실행하지 않고 각 스크립트가 source로 읽는다. 읽으면 저장소 폴더로 옮겨 가서,
# docker compose가 그 폴더의 .env(COMPOSE_FILE)를 읽는다.

REPO_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)
cd "$REPO_DIR"

# 점검 중이라는 표시. 안에 까닭 한 줄이 있다: "restore in-progress", "restore done", "manual", "update".
# 잠금은 스크립트 하나가 도는 동안만 잡혀서, 사람이 손으로 하는 시간은 이 파일이 지킨다.
MARKER_FILE=.maintenance

# 암호화하지 않은 DB와 사진을 잠깐 두는 폴더(백업은 암호화하기 전, 복원은 푼 뒤). 이름을 고정해서,
# 스크립트가 강제로 끊겨(SIGKILL, 정전) 남은 것을 다음 백업이나 복원이 잠금을 잡은 뒤 지운다.
# mktemp로 만들면 끊긴 스크립트의 폴더를 아무도 찾지 못한다.
WORK_DIR=.backup-work

# 운영 스크립트는 한 번에 하나만 돈다. 이미 잠겨 있으면 기다리지 않고 바로 실패한다.
# 잠금은 이 스크립트가 끝나면(실패나 강제 종료 포함) 운영체제가 푼다.
take_lock() {
    exec 9>.maintenance.lock
    if ! flock -n 9; then
        echo "다른 운영 스크립트(백업, 업데이트, 복원, 손작업)가 돌고 있어요" >&2
        exit 1
    fi
}

# 표시가 없으면 빈 글이다.
read_marker() {
    if [ -f "$MARKER_FILE" ]; then
        cat "$MARKER_FILE"
    fi
}

# api가 nginx를 거쳐 응답할 때까지 기다린다. 운영 nginx는 서버 포트를 열지 않아서 nginx 컨테이너 안에서 묻는다.
# 5초마다 묻고 HEALTH_WAIT_SECONDS(기본 60초)가 지나면 실패다.
wait_for_api() {
    local deadline=$((SECONDS + ${HEALTH_WAIT_SECONDS:-60}))
    until docker compose exec -T nginx wget -qO /dev/null -T 5 http://127.0.0.1/api/health 2>/dev/null; do
        if [ "$SECONDS" -ge "$deadline" ]; then
            return 1
        fi
        sleep 5
    done
}

# 서버 설정 값 하나를 찍는다. 환경 변수가 먼저고, 없으면 저장소의 .env, 그것도 없으면 기본값($2)이다. 끝내 없으면 실패다.
# .env를 통째로 source하지 않는다. MAIL_FROM처럼 셸 문법이 아닌 값이 들어 있다.
setting() {
    local name=$1 value=${!1:-}
    if [ -z "$value" ] && [ -f .env ]; then
        value=$(grep -E "^$name=" .env | tail -n 1 | cut -d= -f2-) || true
    fi
    value=${value:-${2:-}}
    if [ -z "$value" ]; then
        echo "$name 설정이 없어요(.env에 적어 주세요)" >&2
        return 1
    fi
    echo "$value"
}

# 개발자에게 알림 메일을 보낸다(docs/deploy.md 정할 것 5). api가 꺼져 있어도 가게 api 이미지로 따로 실행한다.
# 알림이 실패해도 부른 스크립트는 이어 간다.
alert() {
    echo "$1" >&2
    if ! docker compose run --rm --no-deps -T api npm run --silent send-alert -- "$1"; then
        echo "알림 메일을 보내지 못했어요" >&2
    fi
}
