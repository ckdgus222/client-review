# 운영 스크립트 e2e가 스크립트를 돌리는 도구 이미지(docs/deploy.md 정할 것 12). 운영 서버에는 쓰지 않는다.
# 맥에는 flock, gpg, rclone이 없어서, 맥의 Docker 소켓을 꽂은 이 이미지 안에서 스크립트를 돌린다.
# 운영 서버(Ubuntu)와 같은 GNU 도구를 쓰게 coreutils, findutils, tar, util-linux(flock)를 넣는다.
FROM docker:27-cli
RUN apk add --no-cache bash coreutils findutils tar util-linux gnupg rclone git
