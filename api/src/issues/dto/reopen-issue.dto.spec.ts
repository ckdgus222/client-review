import { randomUUID } from 'node:crypto';
import { HttpStatus, ValidationPipe } from '@nestjs/common';
import { ReopenIssueDto } from './reopen-issue.dto.js';

describe('ReopenIssueDto', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
  });
  const versionId = randomUUID();
  const otherId = randomUUID();
  const validate = (changes: Record<string, unknown> = {}) =>
    pipe.transform({ versionId, reason: '고쳤어요', ...changes }, { type: 'body', metatype: ReopenIssueDto });

  it('필수 칸을 받아 DTO로 바꾼다', async () => {
    const result = await validate();
    expect(result).toBeInstanceOf(ReopenIssueDto);
    expect(result.versionId).toBe(versionId);
    expect(result.reason).toBe('고쳤어요');
    expect(result.attemptId).toBeUndefined();
  });

  it.each([1, 2000])('앞뒤 공백을 지운 reason %i자는 통과한다', async (length) => {
    const value = '가'.repeat(length);
    await expect(validate({ reason: ` \t${value}\n ` })).resolves.toMatchObject({ reason: value });
  });

  it('문장 안의 공백과 줄바꿈은 보존한다', async () => {
    await expect(validate({ reason: '  첫 줄\n둘째 줄  ' })).resolves.toMatchObject({ reason: '첫 줄\n둘째 줄' });
  });

  it.each<[string, unknown]>([
    ['없음', undefined],
    ['빈 글자', ''],
    ['공백만', ' \t\n '],
    ['2001자', '가'.repeat(2001)],
    ['null', null],
    ['숫자', 123],
    ['불리언', false],
    ['배열', ['글']],
    ['객체', { text: '글' }],
  ])('reason가 %s이면 422로 거부한다', async (_name, value) => {
    await expect(validate({ reason: value })).rejects.toMatchObject({ status: 422 });
  });

  it.each<[string, unknown]>([
    ['없음', undefined],
    ['null', null],
    ['UUID 아님', 'not-a-uuid'],
    ['빈 글자', ''],
    ['숫자', 123],
    ['불리언', false],
    ['배열', [otherId]],
    ['객체', { id: otherId }],
  ])('versionId가 %s이면 422로 거부한다', async (_name, value) => {
    await expect(validate({ versionId: value })).rejects.toMatchObject({ status: 422 });
  });

  it('attemptId는 생략하거나 UUID로 보낼 수 있다', async () => {
    expect((await validate()).attemptId).toBeUndefined();
    await expect(validate({ attemptId: otherId })).resolves.toMatchObject({ attemptId: otherId });
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['UUID 아님', 'not-a-uuid'],
    ['빈 글자', ''],
    ['숫자', 123],
    ['불리언', false],
    ['배열', [otherId]],
    ['객체', { id: otherId }],
  ])('attemptId가 %s이면 422로 거부한다', async (_name, value) => {
    await expect(validate({ attemptId: value })).rejects.toMatchObject({ status: 422 });
  });

  it.each(['status', 'result', 'authorId', 'reviewedById', 'requestId'])(
    'DTO에 없는 %s 칸은 422로 거부한다',
    async (field) => {
      await expect(validate({ [field]: otherId })).rejects.toMatchObject({ status: 422 });
    },
  );
});
