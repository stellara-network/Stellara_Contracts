import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateTtsJobDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(5000)
  text: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsString()
  voice?: string; // Voice ID or name for TTS engine

  @IsOptional()
  @IsString()
  metadata?: string; // JSON string
}
