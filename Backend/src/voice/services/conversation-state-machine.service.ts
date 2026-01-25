import { Injectable, Logger } from '@nestjs/common';
import { ConversationState } from '../types/conversation-state.enum';

@Injectable()
export class ConversationStateMachineService {
  private readonly logger = new Logger(ConversationStateMachineService.name);

  private readonly validTransitions: Record<ConversationState, ConversationState[]> = {
    [ConversationState.IDLE]: [ConversationState.LISTENING],
    [ConversationState.LISTENING]: [ConversationState.THINKING, ConversationState.INTERRUPTED],
    [ConversationState.THINKING]: [ConversationState.RESPONDING, ConversationState.INTERRUPTED],
    [ConversationState.RESPONDING]: [ConversationState.LISTENING, ConversationState.INTERRUPTED, ConversationState.IDLE],
    [ConversationState.INTERRUPTED]: [ConversationState.LISTENING, ConversationState.IDLE],
  };

  canTransition(from: ConversationState, to: ConversationState): boolean {
    return this.validTransitions[from]?.includes(to) ?? false;
  }

  transition(
    currentState: ConversationState,
    newState: ConversationState,
  ): { success: boolean; error?: string } {
    if (!this.canTransition(currentState, newState)) {
      const error = `Invalid state transition from ${currentState} to ${newState}`;
      this.logger.error(error);
      return { success: false, error };
    }

    this.logger.debug(`State transition: ${currentState} -> ${newState}`);
    return { success: true };
  }

  getValidNextStates(currentState: ConversationState): ConversationState[] {
    return this.validTransitions[currentState] || [];
  }

  isInterruptible(state: ConversationState): boolean {
    return [ConversationState.THINKING, ConversationState.RESPONDING].includes(state);
  }

  isTerminalState(state: ConversationState): boolean {
    return state === ConversationState.IDLE;
  }
}
