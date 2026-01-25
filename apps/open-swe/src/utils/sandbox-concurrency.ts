/**
 * Sandbox Concurrency Manager
 *
 * Implements a semaphore pattern to limit concurrent sandbox creation.
 * This is necessary for Daytona free tier which limits to 2 concurrent sandboxes.
 *
 * Usage:
 * - Set MAX_CONCURRENT_SANDBOXES config to limit (0 = unlimited)
 * - Call acquireSlot() before creating a sandbox
 * - Call releaseSlot() when sandbox is deleted
 */

import { createLogger, LogLevel } from "./logger.js";
import { getConfigNumber } from "@openswe/shared/dynamic-config";

const logger = createLogger(LogLevel.INFO, "SandboxConcurrency");

// Configuration from dynamic config (MongoDB with fallback to process.env)
const MAX_CONCURRENT_SANDBOXES = getConfigNumber("MAX_CONCURRENT_SANDBOXES", 0) ?? 0;
const SLOT_CHECK_INTERVAL_MS = getConfigNumber("SANDBOX_SLOT_CHECK_INTERVAL_MS", 10000) ?? 10000;


/**
 * SandboxConcurrencyManager - Singleton class for managing sandbox concurrency
 */
class SandboxConcurrencyManager {
    private activeSandboxCount = 0;
    private readonly maxConcurrent: number;
    private readonly checkIntervalMs: number;
    private waitingCount = 0;

    constructor(maxConcurrent: number = MAX_CONCURRENT_SANDBOXES, checkIntervalMs: number = SLOT_CHECK_INTERVAL_MS) {
        this.maxConcurrent = maxConcurrent;
        this.checkIntervalMs = checkIntervalMs;

        if (this.isEnabled()) {
            logger.info("Sandbox concurrency limiting enabled", {
                maxConcurrent: this.maxConcurrent,
                checkIntervalMs: this.checkIntervalMs,
            });
        } else {
            logger.info("Sandbox concurrency limiting disabled (unlimited mode)");
        }
    }

    /**
     * Check if concurrency limiting is enabled
     * @returns true if MAX_CONCURRENT_SANDBOXES > 0
     */
    isEnabled(): boolean {
        return this.maxConcurrent > 0;
    }

    /**
     * Get the current active sandbox count
     */
    getActiveCount(): number {
        return this.activeSandboxCount;
    }

    /**
     * Get the maximum concurrent sandboxes allowed
     */
    getMaxConcurrent(): number {
        return this.maxConcurrent;
    }

    /**
     * Get the number of requests currently waiting for a slot
     */
    getWaitingCount(): number {
        return this.waitingCount;
    }

    /**
     * Acquire a sandbox slot. Blocks if at capacity until a slot becomes available.
     * @throws Error if cancelled while waiting
     */
    async acquireSlot(options?: {
        onWaiting?: () => void;
        onHeartbeat?: () => void;
        checkCancelled?: () => Promise<boolean>;
    }): Promise<void> {
        // If concurrency limiting is disabled, return immediately
        if (!this.isEnabled()) {
            return;
        }

        // Check if we're at capacity
        if (this.activeSandboxCount < this.maxConcurrent) {
            this.activeSandboxCount++;
            logger.info("Sandbox slot acquired", {
                active: this.activeSandboxCount,
                max: this.maxConcurrent,
            });
            return;
        }

        // At capacity - need to wait
        logger.warn("At sandbox capacity, waiting for available slot", {
            active: this.activeSandboxCount,
            max: this.maxConcurrent,
            waiting: this.waitingCount + 1,
        });

        this.waitingCount++;

        // Notify caller that we're waiting
        options?.onWaiting?.();

        try {
            // Poll until a slot becomes available
            while (this.activeSandboxCount >= this.maxConcurrent) {
                // Check for cancellation
                if (options?.checkCancelled && (await options.checkCancelled())) {
                    throw new Error("Run cancelled while waiting for sandbox slot");
                }

                // Wait before checking again
                await new Promise((resolve) => setTimeout(resolve, this.checkIntervalMs));

                // Emit heartbeat to keep frontend stream alive during long waits
                options?.onHeartbeat?.();

                logger.debug("Checking for available sandbox slot", {
                    active: this.activeSandboxCount,
                    max: this.maxConcurrent,
                    waiting: this.waitingCount,
                });
            }

            // Slot available - acquire it
            this.activeSandboxCount++;
            logger.info("Sandbox slot acquired after waiting", {
                active: this.activeSandboxCount,
                max: this.maxConcurrent,
            });
        } finally {
            this.waitingCount--;
        }
    }

    /**
     * Release a sandbox slot. Call this when a sandbox is deleted.
     */
    releaseSlot(): void {
        if (!this.isEnabled()) {
            return;
        }

        if (this.activeSandboxCount > 0) {
            this.activeSandboxCount--;
            logger.info("Sandbox slot released", {
                active: this.activeSandboxCount,
                max: this.maxConcurrent,
                waiting: this.waitingCount,
            });
        } else {
            logger.warn("Attempted to release slot when count is already 0");
        }
    }

    /**
     * Reset the counter (useful for testing)
     */
    reset(): void {
        this.activeSandboxCount = 0;
        this.waitingCount = 0;
        logger.debug("Sandbox concurrency counters reset");
    }
}

// Singleton instance
export const sandboxConcurrencyManager = new SandboxConcurrencyManager();

// Export the class for testing
export { SandboxConcurrencyManager };
