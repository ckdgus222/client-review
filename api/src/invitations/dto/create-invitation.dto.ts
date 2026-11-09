import { Transform } from 'class-transformer';
import { IsEmail } from 'class-validator';

export class CreateInvitationDto {
  // 로그인 이메일과 같은 방법으로 정리한다. 그래야 수락할 때 로그인한 이메일과 그대로 비교할 수 있다.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  email: string;
}
