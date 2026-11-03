import { Transform } from 'class-transformer';
import { IsEmail } from 'class-validator';

export class RequestCodeDto {
  // 공백이나 대소문자만 다른 이메일이 한 사람이 되게 검사 전에 정리한다.
  // 문자열이 아니면 그대로 두어서 아래 검사가 422로 거부한다.
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  // 이메일 모양과 함께 이메일 표준의 최대 길이(254자)도 검사한다.
  @IsEmail()
  email: string;
}
