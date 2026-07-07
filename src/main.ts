import { Logger, LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/** Turn LOG_LEVEL into a cumulative Nest log-level list. */
function logLevels(): LogLevel[] {
  const order: LogLevel[] = ['error', 'warn', 'log', 'debug', 'verbose'];
  const wanted = (process.env.LOG_LEVEL?.trim() as LogLevel) || 'log';
  const idx = order.indexOf(wanted);
  return order.slice(0, (idx < 0 ? order.indexOf('log') : idx) + 1);
}

/**
 * nestjs-telegraf launches the bot fire-and-forget during bootstrap, so a
 * failed launch (e.g. a bad token) surfaces as an unhandled rejection. Turn
 * that raw crash into an actionable message and fail fast — under Docker's
 * `restart: unless-stopped` a genuine transient issue then self-heals, while a
 * misconfiguration shows up clearly in the logs.
 */
function installProcessGuards(logger: Logger): void {
  process.on('unhandledRejection', (reason: unknown) => {
    const err = reason as { response?: { error_code?: number }; message?: string };
    if (err?.response?.error_code === 401) {
      logger.error('Telegram rejected the bot token (401). Check TELEGRAM_BOT_TOKEN.');
    } else {
      logger.error(`Unhandled rejection: ${err?.message ?? String(reason)}`);
    }
    process.exit(1);
  });
}

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  installProcessGuards(logger);

  // No HTTP server — the bot only makes outbound calls (Telegram long polling +
  // OLX). An application context runs lifecycle hooks (so nestjs-telegraf
  // launches the bot) without opening any port.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: logLevels(),
  });
  // Fire OnModuleDestroy on SIGINT/SIGTERM so the poll timer is cleared, the bot
  // stops cleanly, and Redis disconnects.
  app.enableShutdownHooks();

  logger.log('🚀 Flat Hunter Bot is running (Telegram long polling).');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
