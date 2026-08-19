import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNumber, IsOptional, IsArray } from 'class-validator';

export class AssetPriceDto {
  @ApiProperty({ description: 'Asset code (e.g., XLM, USDC)' })
  @IsString()
  code: string;

  @ApiProperty({ description: 'Asset issuer public key' })
  @IsString()
  issuer: string;

  @ApiProperty({ description: 'Current price in USD' })
  @IsNumber()
  priceUSD: number;

  @ApiProperty({ description: '24h price change percentage' })
  @IsNumber()
  change24h: number;

  @ApiProperty({ description: '24h trading volume' })
  @IsNumber()
  volume24h: number;

  @ApiProperty({ description: 'Market cap in USD' })
  @IsNumber()
  marketCap: number;

  @ApiProperty({ description: 'Data freshness status (e.g., fresh, stale)' })
  @IsString()
  dataFreshness: string;

  @ApiProperty({ description: 'Data source' })
  @IsString()
  source: string;
}

export class MarketSnapshotDto {
  @ApiProperty({ description: 'List of asset prices', type: [AssetPriceDto] })
  @IsArray()
  assets: AssetPriceDto[];

  @ApiProperty({ description: 'Snapshot timestamp' })
  timestamp: Date;

  @ApiProperty({ description: 'Data source' })
  @IsString()
  source: string;

  @ApiPropertyOptional({ description: 'Whether data was served from cache' })
  @IsOptional()
  cached?: boolean;

  @ApiPropertyOptional({
    description: 'Data freshness status (e.g., fresh, stale)',
  })
  @IsOptional()
  @IsString()
  dataFreshness?: string;
}

export class GetMarketSnapshotQueryDto {
  @ApiPropertyOptional({
    description: 'Comma-separated list of asset codes to filter',
  })
  @IsOptional()
  @IsString()
  assets?: string;

  @ApiPropertyOptional({ description: 'Force cache bypass', type: String })
  @IsOptional()
  bypassCache?: string | boolean;
}
