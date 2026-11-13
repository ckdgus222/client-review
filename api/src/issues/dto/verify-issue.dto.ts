import { IsUUID } from 'class-validator';

export class VerifyIssueDto {
  // 누르는 사람이 보고 있던 버전.
  @IsUUID()
  versionId: string;

  // 누르는 사람이 보고 있던 고쳤어요 줄. 그사이 새 고쳤어요가 왔으면 서버가 409로 멈춘다.
  @IsUUID()
  attemptId: string;
}
