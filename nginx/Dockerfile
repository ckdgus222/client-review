# 1단계: web을 빌드한다. 결과(dist)만 2단계로 가져가고 나머지는 버린다.
FROM node:24-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# 같은 정적 파일을 호스트 배포와 컨테이너 배포에서 사용한다.
FROM scratch AS public-site
COPY landing/ /
COPY --from=web /web/dist /app

FROM nginx:1.30-alpine
COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY nginx/landing.conf nginx/client-ip.conf nginx/limit-zones.conf nginx/login-limit.conf /etc/nginx/
COPY --from=public-site / /usr/share/nginx/html/
