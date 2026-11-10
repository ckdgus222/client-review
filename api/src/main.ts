import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { setupApp } from './setup-app.js';

const app = await NestFactory.create(AppModule);
// 종료 신호(docker stop의 SIGTERM)를 받으면 onModuleDestroy 같은 정리 작업을 하고 끈다.
// 없으면 node가 정리 없이 바로 꺼져서 DB 연결을 닫지 못하고 처리 중인 요청도 끊긴다.
app.enableShutdownHooks();
setupApp(app);
// nginx 설정과 Vite 프록시가 4100을 바라본다. 브라우저 e2e는 개발 서버와 부딪치지 않게 PORT로 다른 포트를 준다.
await app.listen(Number(process.env.PORT ?? 4100));
