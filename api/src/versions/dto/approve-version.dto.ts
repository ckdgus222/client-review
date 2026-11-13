import { IsISO8601, Matches } from 'class-validator';

export class ApproveVersionDto {
  // 승인 검토가 준 serverTime 그대로다: UTC, 마이크로초까지("2026-11-13T06:10:22.123456Z").
  // Matches가 모양을 보고(밀리초까지만 있는 글자, 다른 시간대, 공백 구분을 거부), IsISO8601(strict)가 달력과 시계에 없는 값
  // (2월 30일, 24시, 60분, 60초)을 거부한다. 여기서 걸러야 서비스가 이 글자를 DB의 시각으로 바꿀 때 실패(500)하지 않는다.
  // 해는 1000~9999만 받는다(쪽지 마감일과 같은 이유: 더 작은 해는 IsISO8601이 서버 시간대에 따라 다르게 읽는다).
  @Matches(/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  @IsISO8601({ strict: true })
  seenAt: string;
}
