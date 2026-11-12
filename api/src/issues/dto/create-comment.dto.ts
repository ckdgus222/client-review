import { Transform } from 'class-transformer';
import { IsUUID, Length } from 'class-validator';

export class CreateCommentDto {
  // 브라우저가 댓글 칸을 열 때 만든 번호. 다시 보낼 때도 같은 번호를 쓴다.
  @IsUUID()
  requestId: string;

  // 보내는 사람이 보고 있던 버전.
  @IsUUID()
  versionId: string;

  // 공백을 지운 뒤 길이를 잰다. 공백만 넣으면 0자라서 거부된다. 문자열이 아니면 그대로 두어서 아래 검사가 거부한다.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(1, 2000)
  body: string;
}
