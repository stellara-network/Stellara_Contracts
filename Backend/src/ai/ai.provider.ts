export interface AiProvider {
  generate(prompt: string): Promise<{
    response: string;
    tokensUsed: number;
  }>;
}

export const AI_PROVIDER = 'AI_PROVIDER';
export const AI_FALLBACK_PROVIDER = 'AI_FALLBACK_PROVIDER';
