import type { Endpoint } from './types.js';

export interface EndpointHealthStatus {
  consecutiveFailures: number;
  trippedUntil: number | null;
  lastFailureAt: number | null;
}

export class CircuitBreaker {
  private healthMap = new Map<string, EndpointHealthStatus>();

  public getEndpointKey(endpoint: Endpoint): string {
    return `${endpoint.provider}::${endpoint.model}`;
  }

  public getStatus(endpoint: Endpoint): EndpointHealthStatus {
    const key = this.getEndpointKey(endpoint);
    let status = this.healthMap.get(key);
    if (!status) {
      status = {
        consecutiveFailures: 0,
        trippedUntil: null,
        lastFailureAt: null
      };
      this.healthMap.set(key, status);
    }
    return status;
  }

  public isHealthy(endpoint: Endpoint, now: number = Date.now()): boolean {
    const status = this.getStatus(endpoint);
    if (status.trippedUntil !== null) {
      if (now >= status.trippedUntil) {
        // Cooldown period expired, probationary recovery
        status.trippedUntil = null;
        status.consecutiveFailures = 0;
        return true;
      }
      return false;
    }
    return true;
  }

  public recordFailure(
    endpoint: Endpoint,
    maxFailures: number = 3,
    cooldownMs: number = 60000,
    now: number = Date.now()
  ): boolean {
    const status = this.getStatus(endpoint);
    status.consecutiveFailures += 1;
    status.lastFailureAt = now;

    if (status.consecutiveFailures >= maxFailures) {
      status.trippedUntil = now + cooldownMs;
      return true; // Tripped
    }
    return false;
  }

  public recordSuccess(endpoint: Endpoint): void {
    const key = this.getEndpointKey(endpoint);
    const status = this.healthMap.get(key);
    if (status) {
      status.consecutiveFailures = 0;
      status.trippedUntil = null;
    }
  }

  public filterHealthy(endpoints: Endpoint[], now: number = Date.now()): Endpoint[] {
    if (endpoints.length === 0) return [];
    const healthy = endpoints.filter((e) => this.isHealthy(e, now));
    // Graceful degradation: If all endpoints are tripped, return all to prevent hard stalls
    return healthy.length > 0 ? healthy : endpoints;
  }

  public clear(): void {
    this.healthMap.clear();
  }
}

export const defaultCircuitBreaker = new CircuitBreaker();
