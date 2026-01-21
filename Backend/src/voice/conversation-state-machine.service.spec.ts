import { Test, TestingModule } from '@nestjs/testing';
import { ConversationStateMachineService } from './services/conversation-state-machine.service';
import { ConversationState } from './types/conversation-state.enum';

describe('ConversationStateMachineService', () => {
  let service: ConversationStateMachineService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ConversationStateMachineService],
    }).compile();

    service = module.get<ConversationStateMachineService>(ConversationStateMachineService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('canTransition', () => {
    it('should allow valid transitions from IDLE', () => {
      expect(service.canTransition(ConversationState.IDLE, ConversationState.LISTENING)).toBe(true);
      expect(service.canTransition(ConversationState.IDLE, ConversationState.THINKING)).toBe(false);
      expect(service.canTransition(ConversationState.IDLE, ConversationState.RESPONDING)).toBe(false);
    });

    it('should allow valid transitions from LISTENING', () => {
      expect(service.canTransition(ConversationState.LISTENING, ConversationState.THINKING)).toBe(true);
      expect(service.canTransition(ConversationState.LISTENING, ConversationState.INTERRUPTED)).toBe(true);
      expect(service.canTransition(ConversationState.LISTENING, ConversationState.RESPONDING)).toBe(false);
    });

    it('should allow valid transitions from THINKING', () => {
      expect(service.canTransition(ConversationState.THINKING, ConversationState.RESPONDING)).toBe(true);
      expect(service.canTransition(ConversationState.THINKING, ConversationState.INTERRUPTED)).toBe(true);
      expect(service.canTransition(ConversationState.THINKING, ConversationState.LISTENING)).toBe(false);
    });

    it('should allow valid transitions from RESPONDING', () => {
      expect(service.canTransition(ConversationState.RESPONDING, ConversationState.LISTENING)).toBe(true);
      expect(service.canTransition(ConversationState.RESPONDING, ConversationState.INTERRUPTED)).toBe(true);
      expect(service.canTransition(ConversationState.RESPONDING, ConversationState.IDLE)).toBe(true);
      expect(service.canTransition(ConversationState.RESPONDING, ConversationState.THINKING)).toBe(false);
    });

    it('should allow valid transitions from INTERRUPTED', () => {
      expect(service.canTransition(ConversationState.INTERRUPTED, ConversationState.LISTENING)).toBe(true);
      expect(service.canTransition(ConversationState.INTERRUPTED, ConversationState.IDLE)).toBe(true);
      expect(service.canTransition(ConversationState.INTERRUPTED, ConversationState.THINKING)).toBe(false);
    });
  });

  describe('transition', () => {
    it('should succeed with valid transition', () => {
      const result = service.transition(ConversationState.IDLE, ConversationState.LISTENING);
      
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should fail with invalid transition', () => {
      const result = service.transition(ConversationState.IDLE, ConversationState.RESPONDING);
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid state transition');
    });
  });

  describe('getValidNextStates', () => {
    it('should return valid next states for IDLE', () => {
      const nextStates = service.getValidNextStates(ConversationState.IDLE);
      expect(nextStates).toEqual([ConversationState.LISTENING]);
    });

    it('should return valid next states for LISTENING', () => {
      const nextStates = service.getValidNextStates(ConversationState.LISTENING);
      expect(nextStates).toEqual([ConversationState.THINKING, ConversationState.INTERRUPTED]);
    });

    it('should return valid next states for RESPONDING', () => {
      const nextStates = service.getValidNextStates(ConversationState.RESPONDING);
      expect(nextStates).toEqual([ConversationState.LISTENING, ConversationState.INTERRUPTED, ConversationState.IDLE]);
    });
  });

  describe('isInterruptible', () => {
    it('should return true for interruptible states', () => {
      expect(service.isInterruptible(ConversationState.THINKING)).toBe(true);
      expect(service.isInterruptible(ConversationState.RESPONDING)).toBe(true);
    });

    it('should return false for non-interruptible states', () => {
      expect(service.isInterruptible(ConversationState.IDLE)).toBe(false);
      expect(service.isInterruptible(ConversationState.LISTENING)).toBe(false);
      expect(service.isInterruptible(ConversationState.INTERRUPTED)).toBe(false);
    });
  });

  describe('isTerminalState', () => {
    it('should return true only for IDLE state', () => {
      expect(service.isTerminalState(ConversationState.IDLE)).toBe(true);
      expect(service.isTerminalState(ConversationState.LISTENING)).toBe(false);
      expect(service.isTerminalState(ConversationState.THINKING)).toBe(false);
      expect(service.isTerminalState(ConversationState.RESPONDING)).toBe(false);
      expect(service.isTerminalState(ConversationState.INTERRUPTED)).toBe(false);
    });
  });
});
