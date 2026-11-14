#!/usr/bin/env bash
# 백업 파일로 DB와 사진을 되돌린다(docs/deploy.md 정할 것 9, 절차는 docs/operations.md).
#   deploy/restore.sh <백업 파일>   복원한다. api는 멈춘 채 끝난다
#   deploy/restore.sh --finish      "다시 적용"을 마친 뒤 api를 켠다
# 복원과 --finish 사이에 백업 뒤의 기록(철회, 탈퇴, 삭제 등)을 다시 적용한다. 그 전에 api를 열면
# 철회한 접근과 지운 자료가 잠깐 되살아나서, 점검 표시가 그동안 백업과 업데이트를 막는다.
# 설정(서버 .env 또는 환경 변수): BACKUP_PASSPHRASE_FILE(암호 한 줄이 든 파일)
set -euo pipefail
# 풀어 놓은 DB와 사진은 주인만 읽는다.
umask 077

if [ "$#" -ne 1 ]; then
    echo "사용법: $0 <백업 파일> | --finish" >&2
    exit 1
fi

source "$(dirname "$(readlink -f "$0")")/lib.sh"
take_lock
marker=$(read_marker)

if [ "$1" = --finish ]; then
    if [ "$marker" != "restore done" ]; then
        echo "복원을 마친 표시(restore done)가 없어요(표시: ${marker:-없음})" >&2
        exit 1
    fi
    docker compose start api
    # 표시는 api가 응답한 뒤에 지운다. 먼저 지우면 켜기에 실패했을 때 api가 꺼진 채 다시 켤 길이 없다.
    if ! wait_for_api; then
        echo "api가 응답하지 않아요. docker compose logs api 로 원인을 고친 뒤 $0 --finish 를 다시 돌려 주세요" >&2
        exit 1
    fi
    rm "$MARKER_FILE"
    echo "api를 켰고 점검 표시를 지웠어요"
    exit 0
fi

# 손작업이나 실패한 업데이트 중에는 덮어쓰지 않는다. 실패한 복원(표시가 restore …)만 다시 돌릴 수 있다.
if [ -n "$marker" ] && [[ "$marker" != restore\ * ]]; then
    echo "점검 중이라 복원하지 않아요(표시: $marker)" >&2
    exit 1
fi

# 백업 파일은 절대 경로로 받는다. lib.sh가 저장소 폴더로 옮겨 가서 상대 경로는 어긋난다.
backup_file=$1
passphrase_file=$(setting BACKUP_PASSPHRASE_FILE)
# 지난 백업이나 복원이 강제로 끊겨 남긴 재료부터 지운다.
rm -rf "$WORK_DIR"
mkdir "$WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

# 아무것도 바꾸기 전에 풀고 확인한다. 암호가 틀리거나 파일이 깨졌으면 여기서 끝나고 DB와 사진은 그대로다.
gpg --batch --pinentry-mode loopback --passphrase-file "$passphrase_file" --decrypt "$backup_file" | tar -xf - -C "$WORK_DIR"
for name in snapshot-time.txt db.dump assets.tar; do
    if [ ! -s "$WORK_DIR/$name" ]; then
        echo "백업 파일에 $name 이 없어요" >&2
        exit 1
    fi
done
docker compose exec -T db pg_restore --list < "$WORK_DIR/db.dump" > /dev/null
tar -tf "$WORK_DIR/assets.tar" > /dev/null
snapshot_time=$(cat "$WORK_DIR/snapshot-time.txt")

echo "기준 시각 $snapshot_time 의 백업으로 DB와 사진을 모두 바꿔요. 지금 데이터는 사라져요."
read -r -p "계속하려면 restore 를 입력하세요: " answer
if [ "$answer" != restore ]; then
    echo "복원하지 않았어요" >&2
    exit 1
fi

# DB와 사진을 바꾸기 전에 표시를 남긴다. 중간에 실패하면 이 표시와 멈춘 api가 남아서,
# 반쯤 복원된 DB가 열리지 않고 같은 복원을 다시 돌릴 수 있다.
echo "restore in-progress" > "$MARKER_FILE"
docker compose stop api

docker compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < "$WORK_DIR/db.dump"
docker compose run --rm --no-deps -T api sh -c 'find /data/assets -mindepth 1 -delete && tar -xf - -C /data/assets' < "$WORK_DIR/assets.tar"

# 백업 뒤에 로그아웃한 세션과 이미 쓴 로그인 코드가 되살아나지 않게 모두 지운다(모두 다시 로그인한다).
# 수락하지 않은 초대도 지운다. 백업 뒤에 그 초대로 들어왔다가 철회되거나 탈퇴한 사람이 옛 초대로 다시 들어오지 못한다.
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
DELETE FROM sessions;
DELETE FROM login_codes;
DELETE FROM invitations WHERE accepted_at IS NULL;
SQL

# DB 구조를 지금 코드에 맞춘다. 평소에는 api가 켜질 때 하는 일인데, 다시 적용 스크립트는 api를 켜지 않고 돈다.
docker compose run --rm --no-deps -T api npx prisma migrate deploy

echo "restore done" > "$MARKER_FILE"
echo "복원을 마쳤어요. api는 멈춰 있어요."
echo "기준 시각: $snapshot_time"
echo "이 시각 뒤의 기록(기록 메일, 운영 기록)을 다시 적용한 뒤 $0 --finish 를 돌려 주세요(docs/operations.md)."
