import { Transform } from 'class-transformer';
import { IsUUID, Length } from 'class-validator';

export class WithdrawIssueDto {
  // 누르는 사람이 보고 있던 버전.
  @IsUUID()
  versionId: string;

  // 사유는 댓글로 남는다. 공백을 지운 뒤 길이를 잰다. 문자열이 아니면 그대로 두어서 아래 검사가 거부한다.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(1, 2000)
  reason: string;
}
