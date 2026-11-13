import { Transform } from 'class-transformer';
import { IsUUID, Length, ValidateIf } from 'class-validator';

export class ReopenIssueDto {
  // 누르는 사람이 보고 있던 버전.
  @IsUUID()
  versionId: string;

  // 사유는 댓글로 남는다. 공백을 지운 뒤 길이를 잰다. 문자열이 아니면 그대로 두어서 아래 검사가 거부한다.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(1, 2000)
  reason: string;

  // 확인 요청을 보고 누른 재요청이면 보고 있던 고쳤어요 줄을 보낸다. 끝난 쪽지를 다시 열 때는 보내지 않는다.
  // null은 "보낸 것"이라 검사에 걸린다(IsOptional은 null도 통과시킨다).
  @ValidateIf((_, value) => value !== undefined)
  @IsUUID()
  attemptId?: string;
}
