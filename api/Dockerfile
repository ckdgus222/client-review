FROM node:24-bookworm-slim

# Prisma 마이그레이션 엔진은 OpenSSL에 맞춘 실행 파일이다. slim 이미지에는 없어서 설치한다.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# package 파일을 먼저 복사하면, 코드만 바뀐 빌드는 npm ci 단계를 캐시로 건너뛴다.
# postinstall(prisma generate)이 스키마를 읽어서 prisma 폴더도 함께 복사한다.
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

# exec: sh 대신 node가 그 자리를 이어받아 종료 신호를 직접 받는다.
CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/main"]
