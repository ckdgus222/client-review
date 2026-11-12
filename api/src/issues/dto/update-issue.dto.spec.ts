import { randomUUID } from 'node:crypto';
import { HttpStatus, ValidationPipe } from '@nestjs/common';
import { UpdateIssueDto } from './update-issue.dto.js';

describe('UpdateIssueDto', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
  });
  const versionId = randomUUID();
  const validate = (changes: Record<string, unknown> = {}) =>
    pipe.transform({ versionId, ...changes }, { type: 'body', metatype: UpdateIssueDto });

  it('보내지 않은 선택 칸은 undefined로 두고 versionId를 그대로 넘긴다', async () => {
    // 바꿀 칸이 하나 이상인지는 컨트롤러가 검사하므로 API e2e에서 확인한다.
    const result = await validate();
    expect(result).toBeInstanceOf(UpdateIssueDto);
    expect(result.versionId).toBe(versionId);
    expect(result.category).toBeUndefined();
    expect(result.scope).toBeUndefined();
    expect(result.dueDate).toBeUndefined();
  });

  it.each(['BUG', 'DESIGN', 'COPY', 'OTHER'])('category %s는 그대로 통과한다', async (category) => {
    await expect(validate({ category })).resolves.toMatchObject({ versionId, category });
  });

  it.each(['IN_SCOPE', 'OUT_OF_SCOPE'])('scope %s는 그대로 통과한다', async (scope) => {
    await expect(validate({ scope })).resolves.toMatchObject({ versionId, scope });
  });

  it.each([null, '2026-11-15', '2026-01-01', '2026-12-31', '2000-02-29', '2028-02-29', '2001-01-05'])(
    'dueDate %s는 날짜 글자 또는 null 그대로 통과한다',
    async (dueDate) => {
      await expect(validate({ dueDate })).resolves.toMatchObject({ versionId, dueDate });
    },
  );

  it('세 칸을 함께 보내도 값이 그대로 통과한다', async () => {
    const changes = { category: 'COPY', scope: 'OUT_OF_SCOPE', dueDate: '2027-01-05' };
    await expect(validate(changes)).resolves.toMatchObject({ versionId, ...changes });
  });

  describe.each(['UTC', 'Asia/Seoul', 'America/Los_Angeles'])('서버 시간대가 %s일 때', (timezone) => {
    beforeEach(() => {
      vi.stubEnv('TZ', timezone);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.each(['0202-11-15', '0999-05-05', '0100-01-01', '0000-01-01', '0001-01-01', '1000-02-30'])(
      'dueDate %s는 422로 거부한다',
      async (dueDate) => {
        await expect(validate({ dueDate })).rejects.toMatchObject({ status: 422 });
      },
    );

    it.each(['1000-01-01', '1999-12-31', '9999-12-31', '2028-02-29'])(
      'dueDate %s는 보낸 날짜 그대로 통과한다',
      async (dueDate) => {
        await expect(validate({ dueDate })).resolves.toMatchObject({ versionId, dueDate });
      },
    );
  });

  it.each([
    ['없음', undefined],
    ['null', null],
    ['UUID 아님', 'not-a-uuid'],
    ['빈 글자', ''],
    ['숫자', 123],
    ['불리언', false],
    ['배열', [versionId]],
    ['객체', { id: versionId }],
  ])('versionId가 %s이면 422로 거부한다', async (_name, value) => {
    await expect(validate({ versionId: value, category: 'BUG' })).rejects.toMatchObject({ status: 422 });
  });

  it.each<[string, unknown]>([
    ['category', 'FEATURE'],
    ['category', null],
    ['category', 'bug'],
    ['category', ''],
    ['category', ' BUG '],
    ['category', 0],
    ['category', false],
    ['category', ['BUG']],
    ['category', { value: 'BUG' }],
    ['scope', 'PAGE'],
    ['scope', null],
    ['scope', 'in_scope'],
    ['scope', ''],
    ['scope', ' IN_SCOPE '],
    ['scope', 0],
    ['scope', false],
    ['scope', ['IN_SCOPE']],
    ['scope', { value: 'IN_SCOPE' }],
  ])('%s에 %j를 보내면 422로 거부한다', async (field, value) => {
    await expect(validate({ [field]: value })).rejects.toMatchObject({ status: 422 });
  });

  it.each(
    [
      '2026-02-30',
      '2026-13-01',
      '2027-02-29',
      '1900-02-29',
      '2026-04-31',
      '2026-00-15',
      '2026-11-00',
      '2026-11-32',
      '2026-11-15T00:00:00.000Z',
      '2026-1-5',
      '20261115',
      '',
      ' 2026-11-15 ',
      '2026-11-15\n',
      20261115,
      false,
      [],
      ['2026-11-15'],
      { date: '2026-11-15' },
    ].map((dueDate) => ({ dueDate })),
  )('dueDate가 $dueDate이면 422로 거부한다', async ({ dueDate }) => {
    await expect(validate({ dueDate })).rejects.toMatchObject({ status: 422 });
  });

  it.each(['status', 'title', 'number', 'authorId', 'requestId', 'projectId'])(
    '모르는 칸 %s를 보내면 422로 거부한다',
    async (field) => {
      await expect(validate({ category: 'DESIGN', [field]: versionId })).rejects.toMatchObject({ status: 422 });
    },
  );
});
