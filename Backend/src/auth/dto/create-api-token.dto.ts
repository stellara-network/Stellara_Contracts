import { IsString, IsNotEmpty, IsOptional, IsInt, Min, Max, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateApiTokenDto {
  @ApiProperty({
    description: 'Human-readable name for the API token',
    example: 'AI Service Token',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description: 'Role for the API token',
    example: 'ai-service',
    enum: ['ai-service', 'worker', 'admin'],
  })
  @IsString()
  @IsNotEmpty()
  @IsIn(['ai-service', 'worker', 'admin'])
  role: string;

  @ApiProperty({
    description: 'Token expiration in days (default: 90)',
    example: 90,
    required: false,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
}
