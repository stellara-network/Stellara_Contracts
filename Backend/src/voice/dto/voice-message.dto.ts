import { IsString, IsOptional, IsObject } from 'class-validator';

export class VoiceMessageDto {
  @IsString()
  content: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
