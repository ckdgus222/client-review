import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

// 로그인 없이 여는 주소에 붙인다.
export const Public = () => SetMetadata(IS_PUBLIC, true);
