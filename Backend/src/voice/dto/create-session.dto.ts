import { IsString, IsOptional, IsEnum, IsObject } from 'class-validator';
import { FeatureContext } from '../types/feature-context.enum';

export class CreateSessionDto {
  @IsString()
  userId: string;

  @IsOptional()
  @IsString()
  walletAddress?: string;

  @IsEnum(FeatureContext)
  context: FeatureContext;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
