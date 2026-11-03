import 'reflect-metadata';
import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { OriginGuard } from './origin.guard.js';

const createContext = (method: string, headers: Record<string, string | undefined> = {}) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ method, headers }) }),
  }) as unknown as ExecutionContext;

describe('OriginGuard', () => {
  beforeEach(() => {
    vi.stubEnv('APP_ORIGINS', 'http://localhost:5173,http://localhost:8080');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([undefined, ''])('APP_ORIGINS가 %j이면 생성할 때 오류를 던진다', (value) => {
    vi.stubEnv('APP_ORIGINS', value);

    expect(() => new OriginGuard()).toThrow(/APP_ORIGINS/);
  });

  describe.each(['GET', 'HEAD', 'OPTIONS'])('%s 요청', (method) => {
    it.each([
      { label: '없어도', headers: {} },
      { label: '다른 주소여도', headers: { origin: 'https://other.example' } },
      {
        label: '허용된 주소여도',
        headers: { origin: 'http://localhost:5173' },
      },
    ])('Origin이 $label 통과한다', ({ headers }) => {
      const guard = new OriginGuard();

      expect(guard.canActivate(createContext(method, headers))).toBe(true);
    });
  });

  describe.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s 요청', (method) => {
    it.each(['http://localhost:5173', 'http://localhost:8080'])(
      'Origin이 목록의 %s와 정확히 같으면 통과한다',
      (origin) => {
        const guard = new OriginGuard();

        expect(guard.canActivate(createContext(method, { origin }))).toBe(true);
      },
    );

    it.each([
      { label: 'Origin 헤더 없음', headers: {} },
      { label: '빈 문자열', headers: { origin: '' } },
      {
        label: '다른 호스트',
        headers: { origin: 'http://other.example:5173' },
      },
      {
        label: '프로토콜만 다름',
        headers: { origin: 'https://localhost:5173' },
      },
      { label: '포트만 다름', headers: { origin: 'http://localhost:5174' } },
      { label: '포트 없음', headers: { origin: 'http://localhost' } },
      {
        label: '앞부분만 같음',
        headers: { origin: 'http://localhost:5173.evil.com' },
      },
      {
        label: '끝에 슬래시 있음',
        headers: { origin: 'http://localhost:5173/' },
      },
      { label: '문자열 null', headers: { origin: 'null' } },
      {
        label: '대소문자만 다름',
        headers: { origin: 'http://LOCALHOST:5173' },
      },
      {
        label: '앞뒤 공백 있음',
        headers: { origin: ' http://localhost:5173 ' },
      },
    ])('Origin이 $label이면 403으로 거부한다', ({ headers }) => {
      const guard = new OriginGuard();
      const activate = () => guard.canActivate(createContext(method, headers));

      expect(activate).toThrow(ForbiddenException);
      expect(activate).toThrow(expect.objectContaining({ status: 403 }));
    });
  });

  it.each(['http://localhost:5173', 'http://localhost:8080'])(
    'APP_ORIGINS 목록에 공백이 있어도 %s는 통과한다',
    (origin) => {
      vi.stubEnv('APP_ORIGINS', ' http://localhost:5173, http://localhost:8080 ');
      const guard = new OriginGuard();

      expect(guard.canActivate(createContext('POST', { origin }))).toBe(true);
    },
  );

  it('허용 주소가 하나뿐이어도 해당 Origin은 통과한다', () => {
    vi.stubEnv('APP_ORIGINS', 'http://localhost:8080');
    const guard = new OriginGuard();

    expect(guard.canActivate(createContext('POST', { origin: 'http://localhost:8080' }))).toBe(
      true,
    );
    expect(() =>
      guard.canActivate(createContext('POST', { origin: 'http://localhost:5173' })),
    ).toThrow(ForbiddenException);
  });

  it('HTTPS만 허용하면 같은 호스트와 포트의 HTTP Origin도 거부한다', () => {
    vi.stubEnv('APP_ORIGINS', 'https://localhost:5173');
    const guard = new OriginGuard();

    expect(() =>
      guard.canActivate(createContext('POST', { origin: 'http://localhost:5173' })),
    ).toThrow(ForbiddenException);
    expect(guard.canActivate(createContext('POST', { origin: 'https://localhost:5173' }))).toBe(
      true,
    );
  });

  it('프록시가 Host를 바꿔도 허용된 Origin이면 통과한다', () => {
    const guard = new OriginGuard();

    expect(
      guard.canActivate(
        createContext('POST', {
          origin: 'http://localhost:5173',
          host: 'localhost:4100',
        }),
      ),
    ).toBe(true);
  });

  it.each([undefined, 'https://other.example'])(
    'Host가 허용 주소와 같아도 Origin이 %j이면 거부한다',
    (origin) => {
      const guard = new OriginGuard();

      expect(() =>
        guard.canActivate(createContext('POST', { origin, host: 'localhost:5173' })),
      ).toThrow(ForbiddenException);
    },
  );

  it('GET·HEAD·OPTIONS 외의 메서드는 Origin을 검사한다', () => {
    const guard = new OriginGuard();

    expect(() => guard.canActivate(createContext('PROPFIND'))).toThrow(ForbiddenException);
    expect(() =>
      guard.canActivate(createContext('PROPFIND', { origin: 'https://other.example' })),
    ).toThrow(ForbiddenException);
    expect(guard.canActivate(createContext('PROPFIND', { origin: 'http://localhost:5173' }))).toBe(
      true,
    );
  });
});
