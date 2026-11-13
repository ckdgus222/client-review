import { Transform } from 'class-transformer';
import { IsString } from 'class-validator';

export class DeleteProjectDto {
  // 지울 프로젝트의 이름을 그대로 입력받는다. 만들 때처럼 앞뒤 공백만 지우고, 같은지는 서비스가 본다.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  name: string;
}
