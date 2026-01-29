import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AiRequestDto } from './dto/ai-request.dto';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: any) {}

  @Throttle({ limit: 5, ttl: 10 })
  @Post('prompt')
  async prompt(@Body() dto: AiRequestDto) {
    return this.aiService.handlePrompt(dto);
  }
}
