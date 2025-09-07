# BackgroundTaskRunner

A simple but robust Node.js library for running background tasks with configurable retry logic, error handling, and graceful shutdown capabilities.

## Features

- **Periodic task execution** with configurable intervals
- **Retry mechanisms** with exponential, linear, or constant backoff strategies
- **Custom error handling** with error callbacks
- **Flexible logging** support for console, Winston, Pino, and other loggers
- **Graceful shutdown** with proper cleanup
- **Task timeouts** to prevent hanging operations
- **Thread-safe operations** with countdown latch pattern

## Installation

```bash
npm install @freakynit/background-task-runner
```


## Basic Usage

```javascript
const { BackgroundTaskRunner } = require('@freakynit/background-task-runner');

// Simple task that runs every 30 seconds
const task = async (config) => {
    console.log('Executing background task...');
    // Your task logic here
    await someAsyncOperation();
};

const runner = new BackgroundTaskRunner(task, {
    pollingPeriodSeconds: 30
});

// Start the background runner
await runner.start();

// Later, stop gracefully
await runner.stopAndWait();
```

## Configuration Options

```javascript
const config = {
    pollingPeriodSeconds: 60,        // Run every 60 seconds
    maxRetries: 5,                   // Retry up to 5 times on failure
    baseRetryDelayMs: 1000,          // Base delay of 1 second for retries
    backoffStrategy: "exponential",  // "exponential", "linear", or "constant"
    initialDelayMs: 5000,            // Wait 5 seconds before first run
    taskTimeoutMs: 30000,            // Timeout tasks after 30 seconds
    logTag: "my-background-task",    // Custom log prefix
    onError: (error, context) => {  // Custom error handler
        // Handle errors here
    },
    logger: customLogger             // Custom logger instance
};
```

## Error Handling Example

```javascript
const { BackgroundTaskRunner } = require('@freakynit/background-task-runner');

const unreliableTask = async () => {
    // Simulate a task that fails occasionally
    if (Math.random() < 0.3) {
        throw new Error('Random task failure');
    }
    console.log('Task completed successfully');
};

const runner = new BackgroundTaskRunner(unreliableTask, {
    pollingPeriodSeconds: 10,
    maxRetries: 3,
    backoffStrategy: "exponential",
    onError: (error, context) => {
        console.error(`Task failed after ${context.attempts} attempts:`);
        console.error(`Original error: ${context.originalError.message}`);
        
        // Send to monitoring service
        // sendToMonitoring(error, context);
        
        // Send alert if needed
        if (context.attempts >= context.maxRetries) {
            // sendAlert(`Background task ${context.logTag} failed permanently`);
        }
    }
});

await runner.start();
```

## Custom Logger Example

```javascript
const { BackgroundTaskRunner } = require('@freakynit/background-task-runner');
const winston = require('winston');

// Create a Winston logger
const customLogger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'background-tasks.log' }),
        new winston.transports.Console()
    ]
});

const task = async () => {
    // Your task logic
    await processData();
};

const runner = new BackgroundTaskRunner(task, {
    pollingPeriodSeconds: 120,
    logger: customLogger,
    logTag: "data-processor"
});

await runner.start();
```

## Backoff Strategies

### Exponential Backoff
```javascript
const runner = new BackgroundTaskRunner(task, {
    backoffStrategy: "exponential",
    baseRetryDelayMs: 1000,
    maxRetries: 4
});
// Retry delays: 1s, 2s, 4s, 8s
```

### Linear Backoff
```javascript
const runner = new BackgroundTaskRunner(task, {
    backoffStrategy: "linear",
    baseRetryDelayMs: 2000,
    maxRetries: 3
});
// Retry delays: 2s, 4s, 6s
```

### Constant Backoff
```javascript
const runner = new BackgroundTaskRunner(task, {
    backoffStrategy: "constant",
    baseRetryDelayMs: 5000,
    maxRetries: 5
});
// Retry delays: 5s, 5s, 5s, 5s, 5s
```

## Task Timeout Example

```javascript
const longRunningTask = async () => {
    // Simulate a task that might hang
    await new Promise(resolve => setTimeout(resolve, 45000)); // 45 seconds
};

const runner = new BackgroundTaskRunner(longRunningTask, {
    taskTimeoutMs: 30000, // Timeout after 30 seconds
    onError: (error, context) => {
        if (error.message.includes('timed out')) {
            console.log('Task was terminated due to timeout');
        }
    }
});
```

## Graceful Shutdown

```javascript
const runner = new BackgroundTaskRunner(task, {
    pollingPeriodSeconds: 60
});

await runner.start();

// Handle shutdown signals
process.on('SIGTERM', async () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    await runner.stopAndWait();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('Received SIGINT, shutting down gracefully...');
    await runner.stopAndWait();
    process.exit(0);
});
```

## API Reference

### Constructor

```javascript
new BackgroundTaskRunner(taskFn, config)
```

- `taskFn` (Function): The async function to execute periodically
- `config` (Object): Configuration options (optional)

### Methods

#### `start()`
Starts the background task runner.

```javascript
await runner.start();
```

#### `stop()`
Stops the background task runner immediately.

```javascript
runner.stop();
```

#### `awaitShutdown()`
Waits for the current task to complete before resolving.

```javascript
await runner.awaitShutdown();
```

#### `stopAndWait()`
Combines `stop()` and `awaitShutdown()` for graceful shutdown.

```javascript
await runner.stopAndWait();
```

## Real-world Example

```javascript
const { BackgroundTaskRunner } = require('@freakynit/background-task-runner');
const { DatabaseConnection } = require('./database');
const { EmailService } = require('./email-service');

// Task to process pending email queue
const emailProcessorTask = async (config) => {
    const db = new DatabaseConnection();
    const emailService = new EmailService();
    
    try {
        const pendingEmails = await db.getPendingEmails();
        
        for (const email of pendingEmails) {
            await emailService.send(email);
            await db.markEmailAsSent(email.id);
        }
        
        console.log(`Processed ${pendingEmails.length} emails`);
    } finally {
        await db.close();
    }
};

const emailRunner = new BackgroundTaskRunner(emailProcessorTask, {
    pollingPeriodSeconds: 30,        // Check every 30 seconds
    maxRetries: 3,                   // Retry failed batches 3 times
    backoffStrategy: "exponential",  // Exponential backoff for retries
    taskTimeoutMs: 120000,           // 2 minute timeout
    logTag: "email-processor",
    onError: (error, context) => {
        console.error(`Email processing failed: ${error.message}`);
        // Could send alert to ops team here
    }
});

await emailRunner.start();
console.log('Email processor started');
```

## License

This project is released under an open-source license. See the [LICENSE](LICENSE) file for details.
