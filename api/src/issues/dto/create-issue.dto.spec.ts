import { randomUUID } from 'node:crypto';
import { HttpStatus, ValidationPipe } from '@nestjs/common';
import { CreateIssueDto } from './create-issue.dto.js';

describe('CreateIssueDto', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
  });
  const validate = (changes: Record<string, unknown> = {}) =>
    pipe.transform(
      { requestId: randomUUID(), versionId: randomUUID(), title: '쪽지', body: '', ...changes },
      { type: 'body', metatype: CreateIssueDto },
    );

  it('category를 보내지 않아도 통과한다', async () => {
    const result = await validate();
    expect(result).toBeInstanceOf(CreateIssueDto);
    expect(result.category).toBeUndefined();
  });

  it.each(['BUG', 'DESIGN', 'COPY', 'OTHER'])('category %s는 그대로 통과한다', async (category) => {
    await expect(validate({ category })).resolves.toMatchObject({ category });
  });

  it.each([
    ['없는 값', 'FEATURE'],
    ['null', null],
    ['숫자', 0],
    ['소문자', 'bug'],
    ['빈 문자열', ''],
    ['공백이 붙은 값', ' BUG '],
    ['배열', ['BUG']],
    ['객체', { category: 'BUG' }],
    ['불리언', false],
  ])('category가 %s이면 422로 거부한다', async (_name, category) => {
    await expect(validate({ category })).rejects.toMatchObject({ status: 422 });
  });
});
