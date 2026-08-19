import { WorkflowDefinition, WorkflowContext } from '../types';
import { WorkflowType } from '../types/workflow-type.enum';

export const aiJobChainWorkflow: WorkflowDefinition = {
  type: WorkflowType.AI_JOB_CHAIN,
  name: 'AI Job Chain Pipeline',
  description: 'Execute STT → LLM → TTS pipeline for voice processing',
  requiresCompensation: true,
  maxRetries: 3,
  steps: [
    {
      name: 'process_stt',
      isIdempotent: true,
      maxRetries: 2,
      execute: async (input: any, context: WorkflowContext) => {
        console.log(`Processing STT for workflow: ${context.workflowId}`);

        const { audioUrl, language } = input;

        if (!audioUrl) {
          throw new Error('Audio URL is required for STT processing');
        }

        // Simulate STT processing with job queue
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // In a real implementation, this would enqueue a job to the voice-processing queue
        const transcriptionJobId = `stt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        return {
          jobId: transcriptionJobId,
          audioUrl,
          language: language || 'en-US',
          status: 'processing',
          queuedAt: new Date(),
        };
      },
      compensate: (input: any, output: any, context: WorkflowContext) => {
        console.log(
          `Compensating STT processing for workflow: ${context.workflowId}`,
        );

        if (output?.jobId) {
          // Cancel the STT job if still processing
          console.log(`Cancelling STT job: ${output.jobId}`);
        }
        return Promise.resolve();
      },
    },
    {
      name: 'await_stt_completion',
      isIdempotent: true,
      maxRetries: 5,
      execute: async (input: any, context: WorkflowContext) => {
        console.log(
          `Awaiting STT completion for workflow: ${context.workflowId}`,
        );

        const sttOutput = context.metadata?.process_stt;

        if (!sttOutput?.jobId) {
          throw new Error('STT job not found');
        }

        // Simulate polling for job completion
        let attempts = 0;
        const maxAttempts = 30; // 5 minutes with 10s intervals

        while (attempts < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 10000)); // 10 second polling

          // Simulate checking job status
          const isComplete = Math.random() > 0.3; // 70% chance of completion

          if (isComplete) {
            return {
              jobId: sttOutput.jobId,
              transcribedText:
                'This is the transcribed text from the audio input.',
              confidence: 0.95,
              completedAt: new Date(),
              wordCount: 8,
            };
          }

          attempts++;
        }

        throw new Error('STT processing timed out');
      },
      compensate: (input: any, output: any, context: WorkflowContext) => {
        console.log(
          `Compensating STT await for workflow: ${context.workflowId}`,
        );
        // No specific compensation needed
        return Promise.resolve();
      },
    },
    {
      name: 'process_llm',
      isIdempotent: true,
      maxRetries: 3,
      execute: async (input: any, context: WorkflowContext) => {
        console.log(`Processing LLM for workflow: ${context.workflowId}`);

        const sttOutput = context.metadata?.await_stt_completion;
        const { promptTemplate, model } = input;

        if (!sttOutput?.transcribedText) {
          throw new Error('Transcribed text not available');
        }

        // Simulate LLM processing with job queue
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const llmJobId = `llm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        return {
          jobId: llmJobId,
          inputText: sttOutput.transcribedText,
          promptTemplate: promptTemplate || 'You are a helpful assistant.',
          model: model || 'gpt-4',
          status: 'processing',
          queuedAt: new Date(),
        };
      },
      compensate: (input: any, output: any, context: WorkflowContext) => {
        console.log(
          `Compensating LLM processing for workflow: ${context.workflowId}`,
        );

        if (output?.jobId) {
          // Cancel the LLM job if still processing
          console.log(`Cancelling LLM job: ${output.jobId}`);
        }
        return Promise.resolve();
      },
    },
    {
      name: 'await_llm_completion',
      isIdempotent: true,
      maxRetries: 5,
      execute: async (input: any, context: WorkflowContext) => {
        console.log(
          `Awaiting LLM completion for workflow: ${context.workflowId}`,
        );

        const llmOutput = context.metadata?.process_llm;

        if (!llmOutput?.jobId) {
          throw new Error('LLM job not found');
        }

        // Simulate polling for job completion
        let attempts = 0;
        const maxAttempts = 60; // 10 minutes with 10s intervals

        while (attempts < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 10000)); // 10 second polling

          // Simulate checking job status
          const isComplete = Math.random() > 0.2; // 80% chance of completion

          if (isComplete) {
            return {
              jobId: llmOutput.jobId,
              responseText: 'This is the AI-generated response to your query.',
              tokensUsed: 42,
              completedAt: new Date(),
              model: llmOutput.model,
            };
          }

          attempts++;
        }

        throw new Error('LLM processing timed out');
      },
      compensate: (input: any, output: any, context: WorkflowContext) => {
        console.log(
          `Compensating LLM await for workflow: ${context.workflowId}`,
        );
        // No specific compensation needed
        return Promise.resolve();
      },
    },
    {
      name: 'process_tts',
      isIdempotent: true,
      maxRetries: 2,
      execute: async (input: any, context: WorkflowContext) => {
        console.log(`Processing TTS for workflow: ${context.workflowId}`);

        const llmOutput = context.metadata?.await_llm_completion;
        const { voice, speed } = input;

        if (!llmOutput?.responseText) {
          throw new Error('Response text not available for TTS');
        }

        // Simulate TTS processing with job queue
        await new Promise((resolve) => setTimeout(resolve, 2500));

        const ttsJobId = `tts_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        return {
          jobId: ttsJobId,
          inputText: llmOutput.responseText,
          voice: voice || 'alloy',
          speed: speed || 1.0,
          status: 'processing',
          queuedAt: new Date(),
        };
      },
      compensate: (input: any, output: any, context: WorkflowContext) => {
        console.log(
          `Compensating TTS processing for workflow: ${context.workflowId}`,
        );

        if (output?.jobId) {
          // Cancel the TTS job if still processing
          console.log(`Cancelling TTS job: ${output.jobId}`);
        }
        return Promise.resolve();
      },
    },
    {
      name: 'await_tts_completion',
      isIdempotent: true,
      maxRetries: 5,
      execute: async (input: any, context: WorkflowContext) => {
        console.log(
          `Awaiting TTS completion for workflow: ${context.workflowId}`,
        );

        const ttsOutput = context.metadata?.process_tts;

        if (!ttsOutput?.jobId) {
          throw new Error('TTS job not found');
        }

        // Simulate polling for job completion
        let attempts = 0;
        const maxAttempts = 30; // 5 minutes with 10s intervals

        while (attempts < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 10000)); // 10 second polling

          // Simulate checking job status
          const isComplete = Math.random() > 0.25; // 75% chance of completion

          if (isComplete) {
            const audioPath = `/uploads/tts/response_${Date.now()}.mp3`;

            return {
              jobId: ttsOutput.jobId,
              audioUrl: audioPath,
              duration: 3.5,
              fileSize: 56789,
              completedAt: new Date(),
              voice: ttsOutput.voice,
            };
          }

          attempts++;
        }

        throw new Error('TTS processing timed out');
      },
      compensate: (input: any, output: any, context: WorkflowContext) => {
        console.log(
          `Compensating TTS await for workflow: ${context.workflowId}`,
        );
        // No specific compensation needed
        return Promise.resolve();
      },
    },
    {
      name: 'deliver_final_result',
      isIdempotent: true,
      maxRetries: 1,
      execute: async (input: any, context: WorkflowContext) => {
        console.log(
          `Delivering final result for workflow: ${context.workflowId}`,
        );

        const ttsOutput = context.metadata?.await_tts_completion;

        if (!ttsOutput?.audioUrl) {
          throw new Error('Final audio result not available');
        }

        // Simulate delivering result to user
        await new Promise((resolve) => setTimeout(resolve, 500));

        return {
          audioUrl: ttsOutput.audioUrl,
          duration: ttsOutput.duration,
          deliveredAt: new Date(),
          deliveryMethod: 'websocket', // or 'email', 'download_link', etc.
          userId: context.userId,
        };
      },
      compensate: (input: any, output: any, context: WorkflowContext) => {
        console.log(
          `Compensating final delivery for workflow: ${context.workflowId}`,
        );
        // Log delivery failure for manual intervention
        console.log(`Delivery failed for user ${context.userId}`);
        return Promise.resolve();
      },
    },
  ],
};
