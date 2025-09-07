// constants
const validStrategies = ["exponential", "linear", "constant"];

// default config
const DEFAULT_CONFIG = {
    pollingPeriodSeconds: 60,   // run every 60s
    maxRetries: 5,              // retry count
    baseRetryDelayMs: 1000,     // first retry delay = 1s
    backoffStrategy: "exponential", // one of `validStrategies` from above
    initialDelayMs: 5000,       // first run after 5s
    taskTimeoutMs: 0,           // timeout for task run
    logTag: "background-task",  // tag (log prefix) to use in log statements
    onError: null,              // optional error callback: (error, context) => void
    logger: console             // logger instance (console, winston, pino, etc.)
};

// utilities
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function createCountDownLatch(count) {
    let _resolve;
    let _promise = new Promise((resolve) => {
        _resolve = resolve;
    });

    function countDown() {
        count--;
        if (count <= 0 && _resolve) {
            _resolve();
        }
    }

    async function wait() {
        if (count <= 0) return;
        await _promise;
    }

    return {
        countDown,
        wait
    };
}

// impl class
class BackgroundTaskRunner {
    constructor(taskFn, userConfig = {}) {
        if (typeof taskFn !== "function") {
            throw new Error("taskFn must be a function");
        }

        const config = { ...DEFAULT_CONFIG, ...userConfig };
        this._validateConfig(config);

        this.taskFn = taskFn;
        this.config = config;

        this.timeoutRef = null;
        this.shouldStopNow = false;
        this.latch = null;
        this.isRunning = false;

        // Ensure logger has required methods, fallback to console if missing
        this.logger = this._createLoggerProxy(config.logger);
    }

    _validateConfig(config) {
        if (config.pollingPeriodSeconds <= 0) {
            throw new Error("pollingPeriodSeconds must be positive");
        }
        if (config.maxRetries < 1) {
            throw new Error("maxRetries must be at least 1");
        }
        if (!validStrategies.includes(config.backoffStrategy)) {
            throw new Error(`backoffStrategy must be one of ${validStrategies.join(", ")}`);
        }
        if (config.onError && typeof config.onError !== 'function') {
            throw new Error("maxRetries must be at least 1");
        }
    }

    _createLoggerProxy(logger) {
        return {
            log: logger.log?.bind(logger) || logger.info?.bind(logger) || console.log,
            warn: logger.warn?.bind(logger) || console.warn,
            error: logger.error?.bind(logger) || console.error
        };
    }

    async runTask(shouldStop = () => this.shouldStopNow) {
        for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
            if (shouldStop()) {
                this.logger.log(`[${this.config.logTag}] Received stop signal inside runTask()`);
                return null;
            }

            try {
                let taskPromise = this.taskFn(this.config);

                if (this.config.taskTimeoutMs > 0) {
                    taskPromise = Promise.race([
                        taskPromise,
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error("Task timed out")), this.config.taskTimeoutMs)
                        )
                    ]);
                }

                await taskPromise;
                this.logger.log(`[${this.config.logTag}] Task completed successfully on attempt ${attempt}`);
                break;

            } catch (error) {
                if (attempt < this.config.maxRetries) {
                    const delay = this.getRetryDelay(attempt);
                    this.logger.warn(
                        `[${this.config.logTag}] Attempt ${attempt} failed: ${error.message}. Retrying in ${delay / 1000}s...`
                    );
                    await Promise.race([sleep(delay), new Promise(res => {
                        if (shouldStop()) res();
                    })]);
                } else {
                    this.logger.error(
                        `[${this.config.logTag}] Task failed after ${attempt} attempts:`,
                        error
                    );

                    const finalError = new Error(`Task failed after ${attempt} attempts: ${error.message}`);
                    finalError.originalError = error;
                    finalError.attempts = attempt;

                    // Call error callback if provided
                    if (this.config.onError) {
                        try {
                            this.config.onError(finalError, {
                                attempts: attempt,
                                maxRetries: this.config.maxRetries,
                                logTag: this.config.logTag,
                                originalError: error
                            });
                        } catch (callbackError) {
                            this.logger.error(
                                `[${this.config.logTag}] Error in onError callback:`,
                                callbackError
                            );
                        }
                    }

                    throw finalError;
                }
            }
        }
    }

    getRetryDelay(attempt) {
        switch (this.config.backoffStrategy) {
            case "linear":
                return attempt * this.config.baseRetryDelayMs;
            case "constant":
                return this.config.baseRetryDelayMs;
            case "exponential":
            default:
                return Math.pow(2, attempt - 1) * this.config.baseRetryDelayMs;
        }
    }

    scheduleNext(periodMs = 1000 * this.config.pollingPeriodSeconds) {
        const taskLatch = createCountDownLatch(1);
        this.latch = taskLatch;

        this.timeoutRef = setTimeout(
            async () => {
                try {
                    await this.runTask();
                } catch (error) {
                    this.logger.error(`[${this.config.logTag}] Unhandled task error:`, error);
                } finally {
                    // Always countdown the local latch reference
                    taskLatch.countDown();

                    // Schedule next only if not stopping
                    if (!this.shouldStopNow) {
                        this.scheduleNext();
                    } else {
                        this.logger.log(`[${this.config.logTag}] Not scheduling for next run`);
                    }
                }
            },
            periodMs
        );
    }

    async start() {
        if (this.isRunning) {
            this.logger.log(`[${this.config.logTag}] Already running, ignoring start()`);
            return;
        }

        this.isRunning = true;
        this.shouldStopNow = false;

        // schedule first run
        this.scheduleNext(this.config.initialDelayMs);
    }

    stop() {
        this.logger.log(`[${this.config.logTag}] stop() called`);
        this.isRunning = false;
        this.shouldStopNow = true;

        if (this.timeoutRef) {
            clearTimeout(this.timeoutRef);
        }

        if (this.latch) {
            try {
                this.logger.log(`[${this.config.logTag}] Counting down latch during stop`);
                this.latch.countDown();
            } catch (e) {
                this.logger.error(`[${this.config.logTag}] Error counting down latch`, e);
            } finally {
                this.latch = null;
            }
        }
    }

    async awaitShutdown() {
        this.logger.log(`[${this.config.logTag}] awaitShutdown() called...`);

        if (this.latch) {
            await this.latch.wait();
            this.logger.log(`[${this.config.logTag}] Shutdown complete`);
        } else {
            this.logger.log(`[${this.config.logTag}] No latch to wait for (not running)`);
        }
    }

    async stopAndWait() {
        this.stop();
        await this.awaitShutdown();
    }
}

module.exports = {
    BackgroundTaskRunner,
    DEFAULT_CONFIG
};
