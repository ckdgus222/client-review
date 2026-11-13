import { HttpStatus, ValidationPipe } from '@nestjs/common';
import { ApproveVersionDto } from './approve-version.dto.js';

describe('ApproveVersionDto', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
  });
  const validate = (body: Record<string, unknown>) =>
    pipe.transform(body, { type: 'body', metatype: ApproveVersionDto });

  it.each([
    '2000-02-29T12:34:56.123456Z',
    '2028-02-29T23:59:59.999999Z',
    '2026-01-01T00:00:00.000000Z',
    '1000-01-01T00:00:00.000000Z',
    '9999-12-31T23:59:59.999999Z',
  ])('%s는 마이크로초를 잃지 않고 그대로 통과한다', async (seenAt) => {
    const result = await validate({ seenAt });
    expect(result).toBeInstanceOf(ApproveVersionDto);
    expect(result).toEqual({ seenAt });
  });

  describe.each(['UTC', 'Asia/Seoul', 'America/Los_Angeles'])('서버 시간대가 %s일 때', (timezone) => {
    beforeEach(() => {
      vi.stubEnv('TZ', timezone);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.each([
      '0999-01-01T00:00:00.000000Z',
      '0202-01-01T00:00:00.000000Z',
      '0100-01-01T00:00:00.000000Z',
      '0001-01-01T00:00:00.000000Z',
      '0000-01-01T00:00:00.000000Z',
    ])('seenAt이 %s이면 422로 거부한다', async (seenAt) => {
      await expect(validate({ seenAt })).rejects.toMatchObject({ status: 422 });
    });

    it.each(['1000-01-01T00:00:00.000000Z', '9999-12-31T23:59:59.999999Z'])(
      '%s는 마이크로초를 잃지 않고 그대로 통과한다',
      async (seenAt) => {
        const result = await validate({ seenAt });
        expect(result).toBeInstanceOf(ApproveVersionDto);
        expect(result).toEqual({ seenAt });
      },
    );
  });

  it.each<[string, unknown]>([
    ['없음', undefined],
    ['null', null],
    ['빈 글자', ''],
    ['숫자', 123],
    ['불리언', false],
    ['배열', ['2026-01-01T00:00:00.000000Z']],
    ['객체', { seenAt: '2026-01-01T00:00:00.000000Z' }],
    ['밀리초 3자리', '2026-01-01T00:00:00.123Z'],
    ['소수 7자리', '2026-01-01T00:00:00.1234567Z'],
    ['Z 없음', '2026-01-01T00:00:00.123456'],
    ['시간대 오프셋', '2026-01-01T00:00:00.123456+09:00'],
    ['소문자 z', '2026-01-01T00:00:00.123456z'],
    ['공백 구분', '2026-01-01 00:00:00.123456Z'],
    ['날짜만', '2026-01-01'],
    ['2월 30일', '2026-02-30T00:00:00.000000Z'],
    ['평년 2월 29일', '2027-02-29T00:00:00.000000Z'],
    ['100년 평년', '1900-02-29T00:00:00.000000Z'],
    ['13월', '2026-13-01T00:00:00.000000Z'],
    ['00월', '2026-00-01T00:00:00.000000Z'],
    ['00일', '2026-01-00T00:00:00.000000Z'],
    ['32일', '2026-01-32T00:00:00.000000Z'],
    ['4월 31일', '2026-04-31T00:00:00.000000Z'],
    ['24시', '2026-01-01T24:00:00.000000Z'],
    ['25시', '2026-01-01T25:00:00.000000Z'],
    ['60분', '2026-01-01T00:60:00.000000Z'],
    ['60초', '2026-01-01T00:00:60.000000Z'],
    ['0999년', '0999-01-01T00:00:00.000000Z'],
    ['10000년', '10000-01-01T00:00:00.000000Z'],
    ['앞 공백', ' 2026-01-01T00:00:00.000000Z'],
    ['뒤 공백', '2026-01-01T00:00:00.000000Z '],
    ['뒤 줄바꿈', '2026-01-01T00:00:00.000000Z\n'],
  ])('seenAt이 %s이면 422로 거부한다', async (_name, seenAt) => {
    await expect(validate({ seenAt })).rejects.toMatchObject({ status: 422 });
  });

  it('seenAt 칸을 보내지 않으면 422로 거부한다', async () => {
    await expect(validate({})).rejects.toMatchObject({ status: 422 });
  });

  it('모르는 칸을 보내면 422로 거부한다', async () => {
    await expect(validate({ seenAt: '2026-01-01T00:00:00.123456Z', approverId: 'someone' })).rejects.toMatchObject({
      status: 422,
    });
  });
});
