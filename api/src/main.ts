import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const app = await NestFactory.create(AppModule);
// 종료 신호(docker stop의 SIGTERM)를 받으면 onModuleDestroy 같은 정리 작업을 하고 끈다.
// 없으면 node가 정리 없이 바로 꺼져서 DB 연결을 닫지 못하고 처리 중인 요청도 끊긴다.
app.enableShutdownHooks();
// nginx와 Vite가 /api 주소를 그대로 넘긴다. 경로마다 적지 않게 여기서 한 번 붙인다.
app.setGlobalPrefix('api');
// nginx 설정과 Vite 프록시가 4100을 바라본다.
await app.listen(4100);
