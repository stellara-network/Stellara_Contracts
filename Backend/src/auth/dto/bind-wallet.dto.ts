import { IsString, IsNotEmpty, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class BindWalletDto {
  @ApiProperty({
    description: 'Stellar public key to bind',
    example: 'GABC123...',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^G[A-Z0-9]{55}$/, { message: 'Invalid Stellar public key format' })
  publicKey: string;

  @ApiProperty({
    description: 'Signature proving ownership of the wallet',
    example: 'abc123...',
  })
  @IsString()
  @IsNotEmpty()
  signature: string;

  @ApiProperty({
    description: 'Nonce for signature verification',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsString()
  @IsNotEmpty()
  nonce: string;
}
