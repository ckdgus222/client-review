import { Transform } from 'class-transformer';
import { IsOptional, IsUrl, MaxLength, ValidateIf } from 'class-validator';

// 두 칸 모두 문자열이 아니면 그대로 두어서 아래 검사가 422로 거부한다.
export class UpdateDraftDto {
  // 보내지 않았을 때만 건너뛴다. null도 검사해서 422로 거부한다(설명은 비울 때 빈 글을 보낸다).
  @ValidateIf((_, value) => value !== undefined)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(1000)
  summary?: string;

  // 빈 글은 "주소 지우기"라서 null로 바꾼다. null이면 검사를 건너뛰고 그대로 지운다.
  // 검수실에서 링크로 열리는 주소라 https만 받는다(javascript: 같은 주소를 막는다).
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || null : value))
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2000)
  testUrl?: string | null;
}
