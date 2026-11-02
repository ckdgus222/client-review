import { randomInt } from 'node:crypto';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import bcrypt from 'bcrypt';
import { MailService } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

// bcrypt 반복 횟수(2^12번). 높을수록 해시를 훔친 사람이 코드를 맞혀 보는 데 오래 걸린다.
const BCRYPT_COST = 12;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  // email은 입력 검사(DTO)에서 앞뒤 공백을 지우고 소문자로 바꾼 값이다.
  async requestCode(email: string) {
    // 000000~999999. 앞자리가 0이어도 6자리로 맞춘다.
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    // 느린 계산이라 DB 문장보다 먼저 한다.
    const codeHash = await bcrypt.hash(code, BCRYPT_COST);

    // 넣기·덮어쓰기와 60초 검사를 한 문장으로 한다. 같은 이메일로 동시에 와도 한 요청만 줄을 바꾼다.
    // 시각은 서버 시계가 아니라 DB 시계(now())로 정하고 비교한다.
    const issued = await this.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO login_codes (email, code_hash, expires_at, attempts, used_at, created_at)
      VALUES (${email}, ${codeHash}, now() + interval '10 minutes', 0, NULL, now())
      ON CONFLICT (email) DO UPDATE
        SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at,
            attempts = 0, used_at = NULL, created_at = now()
        WHERE login_codes.created_at <= now() - interval '60 seconds'
      RETURNING id
    `;
    if (issued.length === 0) {
      throw new HttpException(
        '코드는 1분에 한 번만 받을 수 있어요',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    this.mail.sendLoginCode(email, code);
  }
}
