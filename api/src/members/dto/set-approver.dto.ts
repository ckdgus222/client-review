import { IsUUID, ValidateIf } from 'class-validator';

export class SetApproverDto {
  // null은 "지정하지 않음"이다. 칸이 없거나(undefined) UUID 모양이 아니면 422다.
  @ValidateIf((body: SetApproverDto) => body.memberId !== null)
  @IsUUID()
  memberId: string | null;
}
