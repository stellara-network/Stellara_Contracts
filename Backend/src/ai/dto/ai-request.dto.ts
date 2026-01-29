import { IsString, IsNotEmpty } from 'class-validator';

export class AiRequestDto {
  @IsString()
  @IsNotEmpty()
  prompt: string;
}
