import { Transform } from 'class-transformer';
import { Equals, IsEmail } from 'class-validator';

// 이메일 규칙은 코드를 받을 때와 확인할 때 같아야 같은 줄을 찾는다. 그래서 둘 다 이것을 물려받는다.
export class EmailDto {
  // 공백이나 대소문자만 다른 이메일이 한 사람이 되게 검사 전에 정리한다.
  // 문자열이 아니면 그대로 두어서 아래 검사가 422로 거부한다.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  // 이메일 모양과 함께 이메일 표준의 최대 길이(254자)도 검사한다.
  @IsEmail()
  email: string;
}

export class RequestCodeDto extends EmailDto {
  // 개인정보 수집·이용 동의(필수, docs/landing.md 정할 것 5). 불리언 true만 받는다. 문자열 "true"·false·빠짐은 422라서
  // 서비스까지 오지 않고, 코드 줄도 메일도 생기지 않는다.
  @Equals(true)
  privacyAgreed: true;
}
