#!/usr/bin/env bash
# DB와 사진을 한 파일로 묶어 암호화하고, 서버의 USB 디스크와 서버 밖에 둔다(docs/deploy.md 정할 것 8).
#   deploy/backup.sh               매일 낮 12시(cron)
#   deploy/backup.sh --wait-ready  서버를 켤 때(cron @reboot). Docker와 db가 준비될 때까지 기다린 뒤 백업한다
# 설정(서버 .env 또는 환경 변수): BACKUP_DIR(USB 디스크 폴더), BACKUP_REMOTE(rclone 대상),
# BACKUP_PASSPHRASE_FILE(암호 한 줄이 든 파일), BACKUP_WAIT_SECONDS(--wait-ready가 기다리는 시간, 기본 300)
set -euo pipefail
# 백업 재료에는 고객 이메일과 사진이 들어 있다. 만드는 파일은 주인만 읽는다.
umask 077

if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != --wait-ready ]; }; then
    echo "사용법: $0 [--wait-ready]" >&2
    exit 1
fi

source "$(dirname "$(readlink -f "$0")")/lib.sh"

# api를 멈추기 직전에 남기고 다시 켠 뒤 지우는 메모. 백업이 api를 멈춘 채 끊기면(정전, 강제 종료)
# 이 메모가 남아서 다음 백업이 api를 켠다. restart: unless-stopped는 손으로 멈춘 컨테이너를 재부팅 때 켜지 않는다.
API_STOPPED_NOTE=.backup-stopped-api

# 메모가 있으면 api를 켜고, 켜진 뒤에만 메모를 지운다.
start_noted_api() {
    if [ -f "$API_STOPPED_NOTE" ]; then
        docker compose start api && rm "$API_STOPPED_NOTE"
    fi
}

# 멈춰 있거나 아직 없는 db는 아무것도 찍히지 않아서 준비되지 않은 것으로 본다.
db_is_healthy() {
    [ "$(docker compose ps --format '{{.Health}}' db 2>/dev/null)" = healthy ]
}

# 닿을 수 있는 곳만 지운다. 한 곳이 실패해도 다른 곳은 지운다.
prune_old_backups() {
    local result=0
    if ! find "$backup_dir" -maxdepth 1 -type f -name 'client-review-*' -mtime +13 -delete; then
        echo "서버의 14일 지난 백업을 지우지 못했어요" >&2
        result=1
    fi
    if ! rclone delete --min-age 14d --include 'client-review-*' "$backup_remote"; then
        echo "서버 밖의 14일 지난 백업을 지우지 못했어요" >&2
        result=1
    fi
    return "$result"
}

# 백업을 시작한 뒤에는 어디서 끝나든 돈다: 풀어 둔 재료를 지우고, 멈춘 api를 다시 켜고,
# 14일 지난 백업을 지우고, 하나라도 실패했으면 알린다.
finish() {
    local status=$?
    trap - EXIT
    set +e
    # 암호화하기 전의 DB와 사진이 들어 있다. 꼭 지운다.
    rm -rf "$WORK_DIR" "$partial"
    if ! start_noted_api; then
        status=1
    fi
    # 새 백업이 실패해도 지운다. 올리기가 며칠 실패해도 옛 백업이 방침의 14일을 넘겨 남지 않는다.
    if ! prune_old_backups; then
        status=1
    fi
    if [ "$status" -ne 0 ]; then
        alert "백업 실패: 서버에서 deploy/backup.sh 를 돌려 원인을 확인해 주세요"
    fi
    exit "$status"
}

if [ "${1:-}" = --wait-ready ]; then
    # 서버가 막 켜졌을 때는 Docker와 db가 아직 준비되지 않았다. 잠금을 잡기 전에 기다린다.
    deadline=$((SECONDS + $(setting BACKUP_WAIT_SECONDS 300)))
    until db_is_healthy; do
        if [ "$SECONDS" -ge "$deadline" ]; then
            alert "백업 실패: db가 준비되지 않았어요"
            exit 1
        fi
        sleep 5
    done
fi

take_lock
# 지난 백업이 강제로 끊겨 남긴 재료부터 지운다. 점검 중이라 백업하지 않을 때도 지운다.
rm -rf "$WORK_DIR"
marker=$(read_marker)
if [ -n "$marker" ]; then
    # 복원이나 손작업 중이다. api를 켜거나 반쯤 바뀐 DB를 담지 않게 백업은 하지 않는다.
    # 14일 지난 백업 지우기만은 한다. 방침에 적은 보관 기간은 점검이 길어져도 흐른다.
    message="백업 실패: 점검 중이라 백업하지 않았어요(표시: $marker)"
    if ! backup_dir=$(setting BACKUP_DIR) || ! backup_remote=$(setting BACKUP_REMOTE) || ! prune_old_backups; then
        message="$message. 14일 지난 백업도 지우지 못했어요"
    fi
    alert "$message"
    exit 1
fi
if ! backup_dir=$(setting BACKUP_DIR) || ! backup_remote=$(setting BACKUP_REMOTE) ||
    ! passphrase_file=$(setting BACKUP_PASSPHRASE_FILE); then
    alert "백업 실패: 백업 설정이 없어요"
    exit 1
fi

partial="$backup_dir/client-review-$(date -u +%Y%m%dT%H%M%SZ).partial"
trap finish EXIT
mkdir "$WORK_DIR"

if [ -f "$API_STOPPED_NOTE" ]; then
    echo "지난 백업이 api를 멈춘 채 끊겼어요. api를 켜고 이어서 백업해요"
    start_noted_api
fi

# 쓰는 곳이 api 하나라서, api를 멈추면 DB와 사진이 같은 시점으로 굳는다. 시작할 때 멈춰 있던 api는 끝에도 켜지 않는다.
# restarting도 돌고 있는 것으로 본다. 서버가 막 켜졌을 때 api는 db를 기다리며 다시 시작을 되풀이하는데,
# 그 사이(restarting)에는 running으로 잡히지 않아서, 멈추지 않으면 뜨는 도중에 api가 켜진다.
if [ -n "$(docker compose ps -q --status running --status restarting api)" ]; then
    touch "$API_STOPPED_NOTE"
    docker compose stop api
fi

# 기준 시각: 복원 뒤에는 이 시각 뒤의 기록만 다시 적용한다. api가 멈춰 있는 동안의 DB 시계라서,
# api를 다시 켠 뒤 암호화하고 올리는 동안 생긴 철회는 이 시각 뒤가 된다.
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' > "$WORK_DIR/snapshot-time.txt" <<'SQL'
SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
SQL
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$WORK_DIR/db.dump"
docker compose run --rm --no-deps -T api tar -cf - -C /data/assets . > "$WORK_DIR/assets.tar"
start_noted_api

tar -cf - -C "$WORK_DIR" snapshot-time.txt db.dump assets.tar |
    gpg --batch --pinentry-mode loopback --passphrase-file "$passphrase_file" --symmetric --cipher-algo AES256 -o "$partial"
backup_file=${partial%.partial}.tar.gpg
mv "$partial" "$backup_file"
rclone copy "$backup_file" "$backup_remote"
echo "백업을 마쳤어요: $backup_file (기준 시각 $(cat "$WORK_DIR/snapshot-time.txt"))"
