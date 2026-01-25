# Internal Engineering Documentation: LLM Usage Controls & Resilience

## 1. Overview
This update introduces a robust management layer for LLM (Large Language Model) interactions within the Stellara Backend. The primary goals were to:
- **Prevent Abuse**: Implement per-user quotas and rate limiting to control costs and prevent system exhaustion.
- **Optimize Performance**: Add Redis-based caching to reduce redundant LLM calls and improve response times for common queries.
- **Ensure Resilience**: Implement graceful fallbacks and error handling to maintain a stable user experience even during provider outages.

## 2. Summary of Changes
- Created a new `LlmService` to centralize all LLM-related logic including safeguards, caching, and execution.
- Integrated `LlmService` into `StreamingResponseService` to replace direct/mocked AI calls.
- Configured Redis for atomic quota tracking and response caching.
- Added comprehensive unit tests for the new LLM pipeline.

## 3. Affected Areas
- **[llm.service.ts](file:///c:/Users/USER/Documents/Drips_Projects/Stellara_Contracts/Backend/src/voice/services/llm.service.ts)**: Core logic for quotas, rate limiting, caching, and LLM invocation.
- **[streaming-response.service.ts](file:///c:/Users/USER/Documents/Drips_Projects/Stellara_Contracts/Backend/src/voice/services/streaming-response.service.ts)**: Updated to use the new `LlmService` for generating responses.
- **[voice.module.ts](file:///c:/Users/USER/Documents/Drips_Projects/Stellara_Contracts/Backend/src/voice/voice.module.ts)**: Registered `LlmService` as a provider and exported it.
- **[llm.service.spec.ts](file:///c:/Users/USER/Documents/Drips_Projects/Stellara_Contracts/Backend/src/voice/llm.service.spec.ts)**: New test suite for verifying quotas, limits, and caching.

## 4. Implementation Breakdown

### Usage Quotas
- **Strategy**: Monthly requests per user.
- **Storage**: Redis key `quota:{userId}:{YYYY-MM}`.
- **Enforcement**: Incremented atomically on each request. If the value exceeds the `MONTHLY_QUOTA` (default 1000), a `429 Too Many Requests` exception is thrown.
- **TTL**: Keys are set to expire at the end of the current month.

### Rate Limiting
- **Strategy**: Requests per minute (RPM) per user.
- **Storage**: Redis key `ratelimit:{userId}:{timestamp_minute}`.
- **Enforcement**: Uses a fixed-window counter. If requests exceed `RPM_LIMIT` (default 20), the request is rejected.
- **TTL**: Keys expire after 60 seconds.

### Response Caching
- **Key Generation**: `llm:cache:{version}:{model}:{prompt_hash}`.
- **Normalization**: Prompts are trimmed and lowercased before hashing (SHA-256) to ensure deterministic keys.
- **Flow**: Check cache -> Hit: Return cached value -> Miss: Call LLM -> Store in cache.
- **TTL**: Cached responses live for 24 hours.

### Fallback Logic
- **Resilience**: All LLM calls are wrapped in `try-catch` blocks.
- **Graceful Failure**: If the provider fails or a timeout occurs, a standard `FALLBACK_MESSAGE` is returned to the user instead of crashing the stream.
- **Logging**: Failures are logged for observability and debugging.

## 5. Design Decisions
- **Redis for Controls**: Redis was chosen for its high-performance atomic operations (`INCR`), which are ideal for distributed rate limiting and quota tracking.
- **Pre-invocation Checks**: Quota and rate-limit checks occur *before* any LLM call to avoid incurring costs on rejected requests.
- **Hash-based Cache Keys**: Using SHA-256 hashes of prompts ensures fixed-length keys and protects potential sensitive data in prompts from being stored directly in key names.

## 6. Limitations & Future Improvements
- **Sliding Window**: The current RPM limit uses a fixed window; upgrading to a sliding window or token bucket would provide smoother rate limiting.
- **Model-Specific Quotas**: Future iterations could track token usage or cost directly instead of just request counts.
- **Circuit Breaker**: Implementing a circuit breaker pattern (e.g., using `opossum`) could provide better protection against prolonged LLM provider downtime.

## 7. Validation
- **Unit Tests**: Verified quota enforcement, rate limit triggers, cache hits/misses, and fallback behavior in `llm.service.spec.ts`.
- **Integration**: Verified that `StreamingResponseService` correctly consumes the new pipeline.
- **Error Handling**: Explicitly tested the `force-fail` scenario to ensure graceful degradation.
