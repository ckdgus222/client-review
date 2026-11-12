import { Transform } from 'class-transformer';
import { IsNumber, IsUUID, Length, Max, MaxLength, Min, ValidateIf } from 'class-validator';

// 핀은 화면·x·y를 셋 다 보내거나 셋 다 보내지 않는다. 하나라도 보냈으면 셋 다 검사해서,
// 일부만 보낸 요청은 빠진 칸 때문에 422가 된다. null도 "보낸 것"이라 검사에 걸린다.
const hasAnyPinField = (body: CreateIssueDto) =>
  body.screenId !== undefined || body.xRatio !== undefined || body.yRatio !== undefined;

// 범위·마감일·상태·번호·쓴 사람 같은 칸은 여기에 없어서, 보내면 422로 거부된다(setup-app.ts).
export class CreateIssueDto {
  // 브라우저가 쓰기 칸을 열 때 만든 번호. 다시 보낼 때도 같은 번호를 쓴다.
  @IsUUID()
  requestId: string;

  // 보내는 사람이 보고 있던 버전.
  @IsUUID()
  versionId: string;

  // 공백을 지운 뒤 길이를 잰다. 공백만 넣으면 0자라서 거부된다. 문자열이 아니면 그대로 두어서 아래 검사가 거부한다.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(1, 120)
  title: string;

  // 비워도 된다. 줄바꿈과 들여쓰기를 살리려고 공백을 지우지 않는다. MaxLength는 문자열이 아닌 값도 거부한다.
  @MaxLength(4000)
  body: string;

  @ValidateIf(hasAnyPinField)
  @IsUUID()
  screenId?: string;

  // 사진 가로·세로에 대한 비율. IsNumber는 NaN과 무한대도 거부한다.
  @ValidateIf(hasAnyPinField)
  @IsNumber()
  @Min(0)
  @Max(1)
  xRatio?: number;

  @ValidateIf(hasAnyPinField)
  @IsNumber()
  @Min(0)
  @Max(1)
  yRatio?: number;
}
