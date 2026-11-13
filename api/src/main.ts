import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { CleanupService } from './cleanup/cleanup.service.js';
import { NotificationsService } from './notifications/notifications.service.js';
import { setupApp } from './setup-app.js';

const app = await NestFactory.create(AppModule);
// 종료 신호(docker stop의 SIGTERM)를 받으면 onModuleDestroy 같은 정리 작업을 하고 끈다.
// 없으면 node가 정리 없이 바로 꺼져서 DB 연결을 닫지 못하고 처리 중인 요청도 끊긴다.
app.enableShutdownHooks();
setupApp(app);
// nginx 설정과 Vite 프록시가 4100을 바라본다. 브라우저 e2e는 개발 서버와 부딪치지 않게 PORT로 다른 포트를 준다.
await app.listen(Number(process.env.PORT ?? 4100));
// 알림 메일 우편함을 10초마다 꺼내 보낸다. 앱이 꺼질 때(onModuleDestroy) 멈춘다. api e2e는 앱을 직접 만들어서 돌지 않는다.
app.get(NotificationsService).start();
// 지운 프로젝트와 오래된 기록을 켤 때 한 번, 그 뒤 24시간마다 정리한다. api e2e는 runOnce를 직접 부른다.
app.get(CleanupService).start();
