import { IsOptional, IsString, IsUUID } from 'class-validator';

export class UploadAudioDto {
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsString()
  metadata?: string; // JSON string
}
