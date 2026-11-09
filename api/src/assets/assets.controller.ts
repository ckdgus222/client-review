import { Controller, Get, Param, ParseUUIDPipe, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/guards/session.guard.js';
import { assetNotFound, AssetsService } from './assets.service.js';

// 틀린 모양의 id는 DB에 묻기 전에, 없는 사진과 같은 404로 끝낸다.
const assetIdPipe = new ParseUUIDPipe({ exceptionFactory: assetNotFound });

@Controller('assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  // sendFile은 파일 지문(ETag)을 붙이고, 브라우저가 같은 지문으로 다시 물으면 본문 없이 304로 답한다.
  // 권한 검사는 그 앞에서 매번 돌아서, 접근이 끊긴 사람은 304 대신 404를 받는다.
  @Get(':id')
  async get(
    @Req() request: AuthenticatedRequest,
    @Param('id', assetIdPipe) assetId: string,
    @Res() response: Response,
  ) {
    const file = await this.assets.getFileForMember(assetId, request.user.id);

    await new Promise<void>((resolve, reject) => {
      response.sendFile(
        file.path,
        {
          headers: {
            'Content-Type': file.mime,
            // private: 중간 서버(프록시)에 남기지 않는다. no-cache: 위 권한 검사를 매번 거치게 한다.
            'Cache-Control': 'private, no-cache',
            // 브라우저가 내용을 보고 형식을 짐작하지 않게 한다(사진을 HTML로 읽는 일을 막는다).
            'X-Content-Type-Options': 'nosniff',
          },
          // 기본값은 경로에 점 폴더(.assets)가 있으면 404다. 경로는 서버가 만든 값이라 열어 둔다.
          dotfiles: 'allow',
        },
        (error) => {
          // 받다가 페이지를 떠난 것은 서버 잘못이 아니다. 넘기지 않으면 끊길 때마다 오류 기록이 남는다.
          if (!error || response.headersSent) return resolve();
          // send의 오류는 404 표시를 달고 있어서 그대로 넘기면 Nest가 404로 답한다. DB에는 있는데 파일을
          // 못 읽는 것은 서버 쪽 어긋남이라 새 Error로 감싸 500으로 답하고, 경로는 서버 기록에만 남긴다.
          reject(new Error(`사진 파일을 보내지 못했어요: ${file.path}`, { cause: error }));
        },
      );
    });
  }
}
