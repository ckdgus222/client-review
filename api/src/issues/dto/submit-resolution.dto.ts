import { Transform } from 'class-transformer';
import { IsUUID, Length, ValidateIf } from 'class-validator';

export class SubmitResolutionDto {
  // 보내는 사람이 보고 있던 버전. 그사이 새 버전이 게시됐으면 서버가 409로 멈춘다.
  @IsUUID()
  versionId: string;

  // 무엇을 어떻게 고쳤는지. 공백을 지운 뒤 길이를 잰다. 공백만 넣으면 0자라서 거부된다.
  // 문자열이 아니면 그대로 두어서 아래 검사가 거부한다.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(1, 2000)
  summary: string;

  // 고친 결과를 볼 수 있는 화면. 위치 없는 쪽지는 보내지 않아도 된다(핀이 있는 쪽지인데 없으면 서비스가 422로 답한다).
  // null은 "보낸 것"이라 검사에 걸린다(IsOptional은 null도 통과시킨다).
  @ValidateIf((_, value) => value !== undefined)
  @IsUUID()
  screenId?: string;
}
