import { hash, randomBytes } from 'node:crypto';

// 쿠키에 담는 세션 ID. 무작위 32바이트라 맞혀 볼 수 없다.
export const createSessionToken = () => randomBytes(32).toString('base64url');

// DB에는 세션 ID의 해시만 둔다. DB가 새도 쿠키에 넣을 원본은 모른다.
// 원본을 맞혀 볼 수 없으니 bcrypt처럼 느릴 필요가 없고, 같은 값은 늘 같은 해시라 DB에서 바로 찾을 수 있다.
export const hashSessionToken = (token: string) => hash('sha256', token);
