import { HttpStatus, type INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';

// main.ts와 e2e 테스트가 같이 부른다. 테스트 앱이 실제 앱과 같은 설정으로 돌게 하려는 것이다.
export const setupApp = (app: INestApplication) => {
  // nginx와 Vite가 /api 주소를 그대로 넘긴다. 경로마다 적지 않게 여기서 한 번 붙인다.
  app.setGlobalPrefix('api');
  // 세션 가드가 request.cookies에서 세션 ID를 읽는다.
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      // 컨트롤러에 DTO 클래스로 바꾼 값(@Transform으로 정리한 값)을 넘긴다.
      transform: true,
      // DTO에 없는 값은 몰래 지우지 않고 422로 거부한다.
      whitelist: true,
      forbidNonWhitelisted: true,
      errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    }),
  );
};
