import { Transform } from 'class-transformer';
import { IsOptional, Length, Matches } from 'class-validator';
import { EmailDto } from './request-code.dto.js';

// 동의는 코드를 받을 때 끝나서 여기서 다시 받지 않는다.
export class VerifyCodeDto extends EmailDto {
  // 앞자리가 0일 수 있어서 숫자가 아니라 6글자 문자열로 받는다.
  @Matches(/^\d{6}$/)
  code: string;

  // 처음 로그인할 때만 보낸다. 공백만 넣으면 지운 뒤 0자라서 거부된다.
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(1, 30)
  name?: string;
}
