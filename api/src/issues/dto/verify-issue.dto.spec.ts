import { randomUUID } from 'node:crypto';
import { HttpStatus, ValidationPipe } from '@nestjs/common';
import { VerifyIssueDto } from './verify-issue.dto.js';

describe('VerifyIssueDto', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
  });
  const versionId = randomUUID();
  const otherId = randomUUID();
  const validate = (changes: Record<string, unknown> = {}) =>
    pipe.transform({ versionId, attemptId: otherId, ...changes }, { type: 'body', metatype: VerifyIssueDto });

  it('필수 칸을 받아 DTO로 바꾼다', async () => {
    const result = await validate();
    expect(result).toBeInstanceOf(VerifyIssueDto);
    expect(result.versionId).toBe(versionId);
    expect(result.attemptId).toBe(otherId);
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

  it.each<[string, unknown]>([
    ['없음', undefined],
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
