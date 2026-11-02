import { createSessionToken, hashSessionToken } from './token.js';

describe('createSessionToken', () => {
  it('32바이트를 패딩 없는 43자리 base64url로 만든다', () => {
    const token = createSessionToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const bytes = Buffer.from(token, 'base64url');
    expect(bytes).toHaveLength(32);
    expect(bytes.toString('base64url')).toBe(token);
  });

  it('호출할 때마다 다른 토큰을 만든다', () => {
    const tokens = Array.from({ length: 100 }, () => createSessionToken());

    expect(new Set(tokens).size).toBe(100);
  });
});

describe('hashSessionToken', () => {
  it('SHA-256으로 계산한 64자리 소문자 hex를 돌려준다', () => {
    // 공개된 SHA-256 예제 값으로 알고리즘과 인코딩을 함께 확인한다.
    const hash = hashSessionToken('abc');

    expect(hash).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('같은 토큰은 같은 해시이고 다른 토큰은 다른 해시다', () => {
    const first = createSessionToken();
    const second = createSessionToken();

    expect(hashSessionToken(first)).toBe(hashSessionToken(first));
    expect(hashSessionToken(first)).not.toBe(hashSessionToken(second));
    expect(hashSessionToken(first)).not.toBe(first);
  });
});
