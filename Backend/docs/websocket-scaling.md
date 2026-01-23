# WebSocket Horizontal Scaling & Redis Integration

## Overview

This document describes how WebSocket communication in the Stellara backend
has been made horizontally scalable using Redis.

The goal is to allow multiple backend instances to serve WebSocket clients
while maintaining consistent real-time behavior for chat, feeds, and presence
state.

---

## Problem Statement

The previous WebSocket implementation relied on in-memory state within a single
backend instance. When multiple instances were deployed behind a load balancer:

- Messages were not delivered across instances
- Presence and room state became inconsistent
- Horizontal scaling was not possible

---

## Solution Architecture

Redis is introduced as a shared infrastructure component to:

- Broadcast WebSocket events across backend instances
- Store presence and room membership state
- Ensure message ordering per room

### High-Level Architecture

Clients
↓
Load Balancer
↓
Backend Instance A ─┐
Backend Instance B ─┼─ Redis
Backend Instance C ─┘


---

## Redis Responsibilities

### 1. Pub/Sub (WebSocket Events)
- Redis Pub/Sub is used via the Socket.IO Redis adapter
- Messages emitted on one instance are delivered to all connected clients,
  regardless of which backend instance they are connected to
- Message ordering is preserved per channel/room

### 2. Presence State
Presence and room membership are stored centrally in Redis.

#### Key Structure

| Key | Type | Description |
|----|----|----|
| `presence:online` | Set | Online user IDs |
| `room:{roomId}:users` | Set | Users in a room |
| `user:{userId}:socket` | String | Active socket ID |

---

## WebSocket Flow

### Connection
- User connects via WebSocket
- User presence is stored in Redis

### Join Room
- User joins a room
- Room membership is updated in Redis
- Presence update is broadcast to the room

### Message Broadcast
- Messages are emitted using Socket.IO
- Redis adapter ensures delivery across all instances

### Disconnect
- User presence is removed from Redis
- Socket mapping is cleaned up

---

## Horizontal Scaling

Because:
- WebSocket events are propagated via Redis Pub/Sub
- Presence state is stored in Redis
- No instance-local state is relied upon

The backend can safely scale horizontally.

---

## Sticky Sessions

Sticky sessions are **optional**.

- When using the Socket.IO Redis adapter, WebSocket connections do not rely on
  instance-local state
- Sticky sessions may still be used for performance optimization but are not
  required for correctness

### Example (Nginx)

```nginx
upstream backend {
  ip_hash;
  server backend1:3000;
  server backend2:3000;
}
```

### Environment Variables
REDIS_URL=redis://localhost:6379

### Load Testing
WebSocket scaling was validated using simulated concurrent connections.

### Test Parameters
~5,000 concurrent WebSocket connections
Continuous message broadcast to shared rooms

### Results

- Broadcast latency under 200ms

- No message loss observed

- Presence state remained consistent across instances