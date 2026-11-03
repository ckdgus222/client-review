import { Transform } from 'class-transformer';
import { IsOptional, Length, Matches } from 'class-validator';
import { RequestCodeDto } from './request-code.dto.js';

// 이메일 규칙은 코드를 받을 때와 같아야 같은 줄을 찾는다. 그래서 물려받는다.
export class VerifyCodeDto extends RequestCodeDto {
  // 앞자리가 0일 수 있어서 숫자가 아니라 6글자 문자열로 받는다.
  @Matches(/^\d{6}$/)
  code: string;

  // 처음 로그인할 때만 보낸다. 공백만 넣으면 지운 뒤 0자라서 거부된다.
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(1, 30)
  name?: string;
}
