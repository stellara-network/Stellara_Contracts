import { IsString, IsNotEmpty, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UnbindWalletDto {
  @ApiProperty({
    description: 'Stellar public key to unbind',
    example: 'GABC123...',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^G[A-Z0-9]{55}$/, { message: 'Invalid Stellar public key format' })
  publicKey: string;
}
