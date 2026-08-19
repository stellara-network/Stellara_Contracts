// src/voice/voice.controller.ts
import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { VoiceService } from './services/voice.service';
import { IsString, IsNotEmpty } from 'class-validator';

// DTOs defined inline to avoid import issues
class CreateTTSDto {
  @IsString()
  @IsNotEmpty()
  text: string;
}

@Controller('voice')
export class VoiceController {
  constructor(private readonly voiceService: VoiceService) {}

  @Post('stt/upload')
  @UseInterceptors(FileInterceptor('audio'))
  async uploadAudio(
    @UploadedFile() file: { buffer: Buffer; originalname: string },
  ): Promise<{ jobId: string }> {
    if (!file) {
      throw new BadRequestException('No audio file provided');
    }

    const jobId = await this.voiceService.processSTT(file);
    return { jobId };
  }

  @Post('tts/generate')
  async generateTTS(@Body() dto: CreateTTSDto): Promise<{ jobId: string }> {
    const jobId = await this.voiceService.processTTS(dto.text);
    return { jobId };
  }

  @Get('job/:id')
  async getJobStatus(@Param('id') id: string) {
    return this.voiceService.getJobStatus(id);
  }

  @Get('job/:id/result')
  async getJobResult(@Param('id') id: string) {
    return this.voiceService.getJobResult(id);
  }

  @Post('job/:id/retry')
  async retryJob(@Param('id') id: string): Promise<{ jobId: string }> {
    return this.voiceService.retryJob(id);
  }
}
