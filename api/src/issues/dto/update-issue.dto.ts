import { IsEnum, IsISO8601, IsUUID, Matches, ValidateIf } from 'class-validator';
import { IssueCategory, IssueScope } from '../../generated/prisma/client.js';

// null은 "보낸 것"이라 검사에 걸린다(IsOptional은 null도 통과시킨다).
const isSent = (_: unknown, value: unknown) => value !== undefined;

// 보낸 칸만 바꾼다. 상태·제목·번호 같은 칸은 여기에 없어서, 보내면 422로 거부된다(setup-app.ts).
export class UpdateIssueDto {
  // 보내는 사람이 보고 있던 버전.
  @IsUUID()
  versionId: string;

  @ValidateIf(isSent)
  @IsEnum(IssueCategory)
  category?: IssueCategory;

  @ValidateIf(isSent)
  @IsEnum(IssueScope)
  scope?: IssueScope;

  // "YYYY-MM-DD" 모양이면서 달력에 있는 날짜다. null은 마감일을 지운다는 뜻이라 검사하지 않는다.
  // Matches가 모양을 보고(시각이 붙은 글자와 숫자를 거부), IsISO8601(strict)가 2월 30일 같은 없는 날짜를 거부한다.
  // 해는 1000~9999만 받는다. 그보다 작은 해는 IsISO8601이 서버의 현지 시각으로 읽어서 서버 시간대에 따라 통과하기도
  // 거절되기도 한다. 통과하면 잘못 친 해(0202)가 지울 수 없는 자동 댓글로 남는다.
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @Matches(/^[1-9]\d{3}-\d{2}-\d{2}$/)
  @IsISO8601({ strict: true })
  dueDate?: string | null;
}
