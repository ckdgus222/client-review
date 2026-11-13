# 1단계: web을 빌드한다. 결과(dist)만 2단계로 가져가고 나머지는 버린다.
FROM node:24-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# 2단계: nginx에 설정, 소개·약관 파일, web 빌드 결과만 넣는다.
# 브라우저 e2e(e2e/playwright.config.ts)도 같은 이미지로 소개 주소를 확인한다. 판을 바꾸면 두 곳을 함께 고친다.
FROM nginx:1.30-alpine
COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY nginx/landing.conf /etc/nginx/landing.conf
# nginx 기본 index.html을 소개 페이지로 덮어쓴다.
COPY landing/ /usr/share/nginx/html/
COPY --from=web /web/dist /usr/share/nginx/html/app
