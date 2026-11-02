import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const app = await NestFactory.create(AppModule);
// nginx와 Vite가 /api 주소를 그대로 넘긴다. 경로마다 적지 않게 여기서 한 번 붙인다.
app.setGlobalPrefix('api');
// nginx 설정과 Vite 프록시가 4100을 바라본다.
await app.listen(4100);
