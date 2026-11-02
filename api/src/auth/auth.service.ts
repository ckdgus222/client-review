import { randomInt } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import bcrypt from 'bcrypt';
import { MailService } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { createSessionToken, hashSessionToken } from './token.js';

// bcrypt 반복 횟수(2^12번). 높을수록 해시를 훔친 사람이 코드를 맞혀 보는 데 오래 걸린다.
const BCRYPT_COST = 12;

export type AuthUser = { id: string; email: string; name: string };

const AUTH_USER_FIELDS = { id: true, email: true, name: true } as const;

const LOGIN_CODE_ERROR_MESSAGES = {
  CODE_EXPIRED: '코드를 쓸 수 없어요. 새 코드를 받아 주세요',
  CODE_WRONG: '코드가 맞지 않아요',
  NAME_REQUIRED: '처음 오셨네요. 이름을 알려 주세요',
} as const;

// 오류 본문은 Nest 기본 모양에 code를 더한다. web은 code를 보고 문구를 고른다.
const loginCodeError = (code: keyof typeof LOGIN_CODE_ERROR_MESSAGES) =>
  new UnprocessableEntityException({
    statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    message: LOGIN_CODE_ERROR_MESSAGES[code],
    code,
  });

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

  // 돌려준 token(세션 ID 원본)은 컨트롤러가 쿠키에 담는다.
  async verifyCode(
    email: string,
    code: string,
    name?: string,
  ): Promise<{ user: AuthUser; token: string }> {
    // 1. 비교하기 전에 시도 횟수부터 올린다. 동시에 여러 번 와도 5번까지만 해시를 받아 비교한다.
    const [attempt] = await this.prisma.$queryRaw<{ code_hash: string }[]>`
      UPDATE login_codes SET attempts = attempts + 1
      WHERE email = ${email} AND used_at IS NULL AND expires_at > now() AND attempts < 5
      RETURNING code_hash
    `;
    if (!attempt) throw loginCodeError('CODE_EXPIRED');

    // 2. 코드 비교
    const codeHash = attempt.code_hash;
    const isMatch = await bcrypt.compare(code, codeHash);
    if (!isMatch) throw loginCodeError('CODE_WRONG');

    // 3. 처음 온 사람인데 이름이 없으면 이름을 받으러 돌려보낸다.
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: AUTH_USER_FIELDS,
    });
    if (!existingUser && !name) {
      // 코드를 맞힌 뒤의 왕복이라 시도로 치지 않는다. 해시를 조건에 걸어 그사이 새로 받은 코드는 건드리지 않는다.
      await this.prisma.loginCode.updateMany({
        where: { email, codeHash, usedAt: null, attempts: { gt: 0 } },
        data: { attempts: { decrement: 1 } },
      });
      throw loginCodeError('NAME_REQUIRED');
    }

    // 4. 한 트랜잭션이라 중간에 실패하면 코드도 안 쓴 것으로 남는다.
    const token = createSessionToken();
    const user = await this.prisma.$transaction(async (tx) => {
      // 비교한 그 코드일 때만 쓴 것으로 표시한다. 새 코드로 바뀌었거나 다른 요청이 먼저 썼으면 0줄이다.
      const usedCount = await tx.$executeRaw`
        UPDATE login_codes SET used_at = now()
        WHERE email = ${email} AND code_hash = ${codeHash} AND used_at IS NULL AND expires_at > now()
      `;
      if (usedCount === 0) throw loginCodeError('CODE_EXPIRED');

      // 이름 없는 새 사용자는 위에서 NAME_REQUIRED로 돌려보냈다.
      const sessionUser =
        existingUser ??
        (await tx.user.create({
          data: { email, name: name! },
          select: AUTH_USER_FIELDS,
        }));
      await tx.$executeRaw`
        INSERT INTO sessions (user_id, token_hash, expires_at)
        VALUES (${sessionUser.id}::uuid, ${hashSessionToken(token)}, now() + interval '7 days')
      `;
      return sessionUser;
    });

    return { user, token };
  }
}
