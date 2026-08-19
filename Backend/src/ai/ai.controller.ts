import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AiRequestDto } from './dto/ai-request.dto';
import { AiService } from './ai.service';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Throttle({ default: { limit: 5, ttl: 10000 } })
  @Post('prompt')
  async prompt(@Body() dto: AiRequestDto) {
    return this.aiService.handlePrompt(dto);
  }
}
