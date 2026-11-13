import { randomUUID } from 'node:crypto';
import { HttpStatus, ValidationPipe } from '@nestjs/common';
import { SubmitResolutionDto } from './submit-resolution.dto.js';

describe('SubmitResolutionDto', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
  });
  const versionId = randomUUID();
  const otherId = randomUUID();
  const validate = (changes: Record<string, unknown> = {}) =>
    pipe.transform({ versionId, summary: '고쳤어요', ...changes }, { type: 'body', metatype: SubmitResolutionDto });

  it('필수 칸을 받아 DTO로 바꾼다', async () => {
    const result = await validate();
    expect(result).toBeInstanceOf(SubmitResolutionDto);
    expect(result.versionId).toBe(versionId);
    expect(result.summary).toBe('고쳤어요');
    expect(result.screenId).toBeUndefined();
  });

  it.each([1, 2000])('앞뒤 공백을 지운 summary %i자는 통과한다', async (length) => {
    const value = '가'.repeat(length);
    await expect(validate({ summary: ` \t${value}\n ` })).resolves.toMatchObject({ summary: value });
  });

  it('문장 안의 공백과 줄바꿈은 보존한다', async () => {
    await expect(validate({ summary: '  첫 줄\n둘째 줄  ' })).resolves.toMatchObject({ summary: '첫 줄\n둘째 줄' });
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
  ])('summary가 %s이면 422로 거부한다', async (_name, value) => {
    await expect(validate({ summary: value })).rejects.toMatchObject({ status: 422 });
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

  it('screenId는 생략하거나 UUID로 보낼 수 있다', async () => {
    expect((await validate()).screenId).toBeUndefined();
    await expect(validate({ screenId: otherId })).resolves.toMatchObject({ screenId: otherId });
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['UUID 아님', 'not-a-uuid'],
    ['빈 글자', ''],
    ['숫자', 123],
    ['불리언', false],
    ['배열', [otherId]],
    ['객체', { id: otherId }],
  ])('screenId가 %s이면 422로 거부한다', async (_name, value) => {
    await expect(validate({ screenId: value })).rejects.toMatchObject({ status: 422 });
  });

  it.each(['status', 'result', 'authorId', 'reviewedById', 'requestId'])(
    'DTO에 없는 %s 칸은 422로 거부한다',
    async (field) => {
      await expect(validate({ [field]: otherId })).rejects.toMatchObject({ status: 422 });
    },
  );
});
