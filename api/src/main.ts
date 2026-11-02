import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // nginx와 Vite가 /api 주소를 그대로 넘긴다. 경로마다 적지 않게 여기서 한 번 붙인다.
  app.setGlobalPrefix('api');
  await app.listen(process.env.PORT ?? 4100);
}
await bootstrap();
