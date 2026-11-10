import { IsUUID } from 'class-validator';

export class StartIssueDto {
  // 누르는 사람이 보고 있던 버전. 그사이 새 버전이 게시됐으면 서버가 409로 멈춘다.
  @IsUUID()
  versionId: string;
}
