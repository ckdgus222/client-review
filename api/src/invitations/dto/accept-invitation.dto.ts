import { IsString } from 'class-validator';

export class AcceptInvitationDto {
  // 모양이 틀린 토큰도 서비스가 해시해 찾아보고 "사용할 수 없는 초대"(404)로 답한다.
  @IsString()
  token: string;
}
