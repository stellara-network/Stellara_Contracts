import { IsEnum, IsOptional } from 'class-validator';
import { ConversationState } from '../types/conversation-state.enum';

export class SessionActionDto {
  @IsOptional()
  @IsEnum(ConversationState)
  state?: ConversationState;

  @IsOptional()
  interrupt?: boolean;
}
