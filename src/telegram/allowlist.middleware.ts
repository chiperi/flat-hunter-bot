import { Logger } from '@nestjs/common';
import { Context, MiddlewareFn } from 'telegraf';
import { ACCESS_RESTRICTED } from './telegram.copy';

/**
 * Global Telegraf middleware enforcing the static allowlist BEFORE any command,
 * scene step, or callback is processed. Fails closed: an empty allowlist rejects
 * everyone. A blocked user gets a polite reply, not silence and not a raw error.
 */
export function createAllowlistMiddleware(allowedIds: number[]): MiddlewareFn<Context> {
  const allowed = new Set(allowedIds);
  const logger = new Logger('Allowlist');

  if (allowed.size === 0) {
    logger.warn('ALLOWED_USER_IDS is empty — every user will be rejected until it is set.');
  } else {
    logger.log(`Allowlist active for ${allowed.size} user id(s).`);
  }

  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId && allowed.has(userId)) {
      return next();
    }
    logger.warn(`Blocked update from user ${userId ?? 'unknown'}`);
    if (ctx.chat) {
      try {
        await ctx.reply(ACCESS_RESTRICTED);
      } catch {
        // Ignore — e.g. the user blocked the bot. Never let this throw.
      }
    }
    // Deliberately do NOT call next(): stop the update here.
  };
}
