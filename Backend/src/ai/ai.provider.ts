export interface AiProvider {
  generate(prompt: string): Promise<{
    response: string;
    tokensUsed: number;
  }>;
}
