import { Injectable, Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { VoiceSessionService } from './voice-session.service';
import { LlmService } from './llm.service';
import { ConversationState } from '../types/conversation-state.enum';
import { v4 as uuidv4 } from 'uuid';

export interface StreamingChunk {
  id: string;
  content: string;
  isComplete: boolean;
  isPartial: boolean;
  metadata?: Record<string, any>;
}

export interface StreamingResponse {
  id: string;
  sessionId: string;
  chunks: StreamingChunk[];
  startTime: Date;
  endTime?: Date;
  isInterrupted: boolean;
}

@Injectable()
export class StreamingResponseService {
  private readonly logger = new Logger(StreamingResponseService.name);
  private readonly activeStreams = new Map<string, StreamingResponse>();

  constructor(
    private readonly voiceSessionService: VoiceSessionService,
    private readonly llmService: LlmService,
  ) {}

  async startStreamingResponse(
    server: Server,
    sessionId: string,
    userMessage: string,
  ): Promise<string> {
    const streamId = uuidv4();
    const session = await this.voiceSessionService.getSession(sessionId);
    
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Add user message to session
    await this.voiceSessionService.addMessage(sessionId, userMessage, true);

    // Update session state to thinking
    await this.voiceSessionService.updateSessionState(sessionId, ConversationState.THINKING);

    // Create streaming response
    const streamingResponse: StreamingResponse = {
      id: streamId,
      sessionId,
      chunks: [],
      startTime: new Date(),
      isInterrupted: false,
    };

    this.activeStreams.set(streamId, streamingResponse);

    // Notify client that thinking started
    server.to(session.socketId || sessionId).emit('voice:thinking', {
      sessionId,
      streamId,
    });

    // Simulate AI processing delay (in real implementation, this would call AI service)
    setTimeout(() => {
      this.generateStreamingResponse(server, sessionId, streamId, userMessage);
    }, 1000);

    return streamId;
  }

  private async generateStreamingResponse(
    server: Server,
    sessionId: string,
    streamId: string,
    userMessage: string,
  ): Promise<void> {
    const session = await this.voiceSessionService.getSession(sessionId);
    if (!session) return;

    const streamingResponse = this.activeStreams.get(streamId);
    if (!streamingResponse || streamingResponse.isInterrupted) return;

    // Update session state to responding
    await this.voiceSessionService.updateSessionState(sessionId, ConversationState.RESPONDING);

    // Get response from LLM service (with quotas, rate limiting, and caching)
    const { content: fullResponse } = await this.llmService.generateResponse(session.userId, userMessage);
    const words = fullResponse.split(' ');
    
    // Update session state to responding
    server.to(session.socketId || sessionId).emit('voice:responding', {
      sessionId,
      streamId,
    });

    let currentText = '';
    const chunkDelay = 100; // milliseconds between chunks

    for (let i = 0; i < words.length; i++) {
      const streamingResponseCheck = this.activeStreams.get(streamId);
      if (!streamingResponseCheck || streamingResponseCheck.isInterrupted) {
        this.logger.log(`Stream ${streamId} was interrupted`);
        return;
      }

      currentText += (i > 0 ? ' ' : '') + words[i];
      
      const chunk: StreamingChunk = {
        id: uuidv4(),
        content: currentText,
        isComplete: i === words.length - 1,
        isPartial: i < words.length - 1,
      };

      streamingResponseCheck.chunks.push(chunk);

      // Send chunk to client
      server.to(session.socketId || sessionId).emit('voice:chunk', {
        sessionId,
        streamId,
        chunk,
      });

      // Add delay to simulate real-time streaming
      if (i < words.length - 1) {
        await new Promise(resolve => setTimeout(resolve, chunkDelay));
      }
    }

    // Complete the stream
    await this.completeStreamingResponse(server, sessionId, streamId, fullResponse);
  }

  async interruptStream(
    server: Server,
    sessionId: string,
    streamId?: string,
  ): Promise<boolean> {
    const session = await this.voiceSessionService.getSession(sessionId);
    if (!session) return false;

    // If specific stream ID provided, interrupt that stream
    if (streamId) {
      const streamingResponse = this.activeStreams.get(streamId);
      if (streamingResponse) {
        streamingResponse.isInterrupted = true;
        streamingResponse.endTime = new Date();
        
        server.to(session.socketId || sessionId).emit('voice:interrupted', {
          sessionId,
          streamId,
        });

        this.activeStreams.delete(streamId);
      }
    } else {
      // Interrupt all active streams for this session
      for (const [id, response] of this.activeStreams.entries()) {
        if (response.sessionId === sessionId) {
          response.isInterrupted = true;
          response.endTime = new Date();
          
          server.to(session.socketId || sessionId).emit('voice:interrupted', {
            sessionId,
            streamId: id,
          });
        }
      }

      // Remove all streams for this session
      for (const id of this.activeStreams.keys()) {
        const response = this.activeStreams.get(id);
        if (response?.sessionId === sessionId) {
          this.activeStreams.delete(id);
        }
      }
    }

    // Update session state
    await this.voiceSessionService.interruptSession(sessionId);
    
    this.logger.log(`Interrupted streaming for session ${sessionId}`);
    return true;
  }

  private async completeStreamingResponse(
    server: Server,
    sessionId: string,
    streamId: string,
    fullResponse: string,
  ): Promise<void> {
    const session = await this.voiceSessionService.getSession(sessionId);
    if (!session) return;

    const streamingResponse = this.activeStreams.get(streamId);
    if (!streamingResponse) return;

    streamingResponse.endTime = new Date();

    // Add AI response to session
    await this.voiceSessionService.addMessage(sessionId, fullResponse, false);

    // Send completion event
    server.to(session.socketId || sessionId).emit('voice:complete', {
      sessionId,
      streamId,
      response: fullResponse,
    });

    // Update session state to listening
    await this.voiceSessionService.updateSessionState(sessionId, ConversationState.LISTENING);

    // Clean up stream
    this.activeStreams.delete(streamId);

    this.logger.log(`Completed streaming response ${streamId} for session ${sessionId}`);
  }

  getActiveStreamCount(): number {
    return this.activeStreams.size;
  }

  getActiveStreamsForSession(sessionId: string): StreamingResponse[] {
    return Array.from(this.activeStreams.values())
      .filter(stream => stream.sessionId === sessionId);
  }
}
