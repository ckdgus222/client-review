# 1단계: web을 빌드한다. 결과(dist)만 2단계로 가져가고 나머지는 버린다.
FROM node:24-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# 2단계: nginx에 설정과 web 빌드 결과만 넣는다.
FROM nginx:1.30-alpine
COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web /web/dist /usr/share/nginx/html/app
