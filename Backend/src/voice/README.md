# Real-Time Voice Intelligence & Conversation State Engine

This module provides a comprehensive real-time voice conversation engine for Stellara AI, enabling continuous voice interaction with users across learning, trading explanations, and community support.

## Architecture Overview

The voice engine is built with the following core components:

### Core Services

- **VoiceSessionService**: Manages voice session lifecycle, persistence, and state
- **ConversationStateMachineService**: Handles conversation state transitions and validation
- **StreamingResponseService**: Manages real-time streaming AI responses
- **SessionCleanupService**: Handles automatic cleanup of expired sessions

### Gateway

- **VoiceGateway**: WebSocket gateway handling real-time client connections

## Features

### 🎯 Voice Session Management
- Create, resume, and terminate voice sessions
- Tie sessions to user ID, wallet address, and feature context
- Enforce session TTL and automatic cleanup
- Support for concurrent session isolation

### 🔄 Conversation State Machine
- **States**: `IDLE`, `LISTENING`, `THINKING`, `RESPONDING`, `INTERRUPTED`
- Valid state transitions with validation
- Interrupt handling for thinking/responding states
- Consistent state recovery

### 📡 Streaming Response Engine
- Incremental AI response streaming via WebSockets
- Support for partial TTS playback during generation
- User interruption handling (stop/re-prompt)
- Multiple concurrent stream management

### 💾 Context Persistence
- Store user prompts and AI responses with timestamps
- Feature context tracking (academy, trading, general, community)
- Session replay and continuation support
- Redis-based persistence with TTL

### 🔒 Security & Performance
- Per-user session limits
- Session hijacking prevention
- Bounded WebSocket memory usage
- Race condition prevention

## WebSocket API

### Connection
```typescript
// Connect to voice namespace
const socket = io('/voice', {
  auth: {
    userId: 'user123',
    sessionId?: 'session123' // For session resumption
  }
});
```

### Events

#### Client → Server

**Create Session**
```typescript
socket.emit('voice:create-session', {
  userId: 'user123',
  context: 'academy', // 'academy' | 'trading' | 'general' | 'community'
  walletAddress?: '0x...',
  metadata?: { lessonId: 'lesson123' }
});
```

**Send Message**
```typescript
socket.emit('voice:message', {
  content: 'How does staking work?',
  metadata?: { emotion: 'curious' }
});
```

**Interrupt Response**
```typescript
socket.emit('voice:interrupt', {
  streamId?: 'stream123' // Optional - interrupts all if not provided
});
```

**Session Actions**
```typescript
socket.emit('voice:action', {
  state: 'listening', // Optional state transition
  interrupt: true // Optional interrupt flag
});
```

**Terminate Session**
```typescript
socket.emit('voice:terminate');
```

**Ping/Pong**
```typescript
socket.emit('voice:ping');
```

#### Server → Client

**Session Created**
```typescript
socket.on('voice:session-created', ({ session }) => {
  console.log('Session created:', session.id);
});
```

**Session Resumed**
```typescript
socket.on('voice:resumed', ({ sessionId, state }) => {
  console.log('Session resumed:', sessionId, state);
});
```

**Thinking State**
```typescript
socket.on('voice:thinking', ({ sessionId, streamId }) => {
  console.log('AI is thinking...');
});
```

**Responding State**
```typescript
socket.on('voice:responding', ({ sessionId, streamId }) => {
  console.log('AI is responding...');
});
```

**Response Chunk**
```typescript
socket.on('voice:chunk', ({ sessionId, streamId, chunk }) => {
  console.log('Partial response:', chunk.content);
  // Can be used for incremental TTS playback
});
```

**Response Complete**
```typescript
socket.on('voice:complete', ({ sessionId, streamId, response }) => {
  console.log('Full response:', response);
});
```

**Interrupted**
```typescript
socket.on('voice:interrupted', ({ sessionId, streamId }) => {
  console.log('Response was interrupted');
});
```

**State Updated**
```typescript
socket.on('voice:state-updated', ({ sessionId, state }) => {
  console.log('New state:', state);
});
```

**Session Terminated**
```typescript
socket.on('voice:terminated', ({ sessionId }) => {
  console.log('Session ended:', sessionId);
});
```

**Error Handling**
```typescript
socket.on('voice:error', ({ message }) => {
  console.error('Voice error:', message);
});
```

**Ping Response**
```typescript
socket.on('voice:pong', ({ timestamp }) => {
  console.log('Pong received at:', timestamp);
});
```

## State Machine

### Valid Transitions
- `IDLE` → `LISTENING`
- `LISTENING` → `THINKING` | `INTERRUPTED`
- `THINKING` → `RESPONDING` | `INTERRUPTED`
- `RESPONDING` → `LISTENING` | `INTERRUPTED` | `IDLE`
- `INTERRUPTED` → `LISTENING` | `IDLE`

### Interruptible States
- `THINKING`
- `RESPONDING`

## Configuration

### Environment Variables
```bash
REDIS_URL=redis://localhost:6379
PORT=3000
```

### Session Configuration
- **Default TTL**: 3600 seconds (1 hour)
- **Cleanup Interval**: 5 minutes
- **Max Concurrent Sessions**: Per user limits enforced

## Usage Examples

### Basic Voice Session
```typescript
// 1. Create session
socket.emit('voice:create-session', {
  userId: 'user123',
  context: 'academy'
});

// 2. Send message
socket.emit('voice:message', {
  content: 'Explain DeFi staking'
});

// 3. Handle streaming response
socket.on('voice:chunk', ({ chunk }) => {
  // Process incremental response
  updateUI(chunk.content);
});

// 4. Interrupt if needed
socket.emit('voice:interrupt');
```

### Session Resumption
```typescript
// Connect with existing session
const socket = io('/voice', {
  auth: {
    userId: 'user123',
    sessionId: 'existing-session-id'
  }
});

socket.on('voice:resumed', ({ sessionId, state }) => {
  console.log('Resumed session:', sessionId);
});
```

## Testing

Run the comprehensive test suite:
```bash
npm test

# Run with coverage
npm run test:cov

# Run specific test file
npm test -- voice-session.service.spec.ts
```

### Test Coverage
- Voice session lifecycle management
- Conversation state transitions
- Streaming response functionality
- WebSocket gateway events
- Session cleanup and TTL
- Error handling scenarios

## Performance Considerations

### Memory Management
- Active streams are tracked and cleaned up
- Session data is persisted in Redis with TTL
- WebSocket connections are properly managed

### Scalability
- Redis adapter for multi-instance scaling
- Session isolation prevents cross-talk
- Bounded concurrent operations per user

### Security
- User authentication required for all operations
- Session validation prevents hijacking
- Wallet address association for crypto features

## Monitoring

### Key Metrics
- Active voice sessions
- Streaming response count
- Session duration and completion rates
- Interruption frequency
- Error rates by type

### Logs
- Session lifecycle events
- State transitions
- Stream start/complete/interrupt
- Cleanup operations
- Error conditions

## Integration Points

### STT/TTS Integration
The voice engine operates on top of STT/TTS outputs:
- STT results come as `voice:message` events
- TTS playback can use `voice:chunk` events for incremental audio

### AI Service Integration
Replace the mock AI response in `StreamingResponseService` with actual AI service calls.

### Analytics Integration
Session data and conversation logs can be streamed to analytics services for learning progress tracking.

## Error Handling

### Common Errors
- `'Authentication required'` - Missing user ID in auth
- `'No active session'` - User has no active voice session
- `'Invalid session'` - Session not found or user mismatch
- `'Invalid state transition'` - Disallowed state change
- `'Failed to interrupt'` - Session not in interruptible state

### Recovery Strategies
- Automatic session resumption on reconnect
- State reset on critical errors
- Graceful degradation for network issues

## Future Enhancements

### Planned Features
- Voice activity detection integration
- Emotion and sentiment analysis
- Multi-language support
- Voice biometrics for authentication
- Advanced conversation analytics

### Performance Improvements
- Connection pooling for AI services
- Response caching for common queries
- Load balancing for high-traffic scenarios
- Edge deployment for reduced latency
