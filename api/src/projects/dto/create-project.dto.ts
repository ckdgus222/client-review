import { Transform } from 'class-transformer';
import { Length } from 'class-validator';

export class CreateProjectDto {
  // "메인"과 "메인 "이 다른 이름이 되지 않게 공백을 지운 뒤 길이를 잰다. 공백만 넣으면 0자라서 거부된다.
  // 문자열이 아니면 그대로 두어서 아래 검사가 422로 거부한다.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(1, 60)
  name: string;
}
