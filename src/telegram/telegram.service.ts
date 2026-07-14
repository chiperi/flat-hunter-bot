import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Context } from 'telegraf';
import { Listing } from '../sources/listing.interface';
import { SearchProfile } from '../search-profiles/search-profile.model';
import { esc } from './telegram.copy';

/**
 * Outbound messaging used by the scheduler. Injects the bot instance so it can
 * send messages outside of an update handler.
 *
 * Notification methods THROW on a genuine send failure (after trying a
 * text fallback). That contract lets the scheduler mark a listing as "seen"
 * only after a confirmed delivery — a crash/failure mid-notify leaves it unseen
 * so it retries next cycle rather than being silently swallowed.
 */
@Injectable()
export class TelegramService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TelegramService.name);

  constructor(@InjectBot() private readonly bot: Telegraf<Context>) {}

  /**
   * Register the command menu once at startup, so the commands show up in
   * Telegram's "Menu" button and the `/` autocomplete list. Best-effort — a
   * failure here must never block the bot from running.
   */
  async onApplicationBootstrap(): Promise<void> {
    // Global error boundary: contain any throw from a command/action/wizard step
    // so one user's bad interaction is logged, not propagated to the process-wide
    // unhandledRejection guard (which would exit). Resilience req: one user's
    // Telegram error must not take the bot down for everyone.
    this.bot.catch((err, ctx) => {
      this.logger.error(
        `Handler error (update=${ctx?.updateType}, chat=${ctx?.chat?.id}): ${(err as Error).message}`,
      );
    });

    try {
      await this.bot.telegram.setMyCommands([
        { command: 'newsearch', description: '🔎 Новий пошук' },
        { command: 'mysearches', description: '📋 Мої пошуки' },
        { command: 'pause', description: '⏸ Призупинити пошук: /pause <id>' },
        { command: 'resume', description: '▶️ Відновити пошук: /resume <id>' },
        { command: 'forgetme', description: '🧹 Видалити всі мої дані' },
        { command: 'help', description: 'ℹ️ Довідка' },
        { command: 'start', description: '👋 Почати' },
      ]);
      this.logger.log('Registered bot command menu (setMyCommands).');
    } catch (err) {
      this.logger.warn(`setMyCommands failed: ${(err as Error).message}`);
    }
  }

  async notifyNewListing(profile: SearchProfile, listing: Listing): Promise<void> {
    const caption = this.buildCaption('🆕 <b>Нове оголошення</b>', profile, listing);
    await this.send(profile.chatId, caption, listing.imageUrl);
  }

  async notifyPriceChange(
    profile: SearchProfile,
    listing: Listing,
    oldPrice: number | null,
  ): Promise<void> {
    const arrow =
      listing.price != null && oldPrice != null
        ? listing.price < oldPrice
          ? '📉'
          : '📈'
        : '💱';
    const header =
      `${arrow} <b>Зміна ціни</b>\n` +
      `<s>${this.formatPrice(oldPrice, listing.currency)}</s> → ` +
      `<b>${this.formatPrice(listing.price, listing.currency)}</b>`;
    const caption = this.buildCaption(header, profile, listing, /* includePrice */ false);
    await this.send(profile.chatId, caption, listing.imageUrl);
  }

  /** Plain text helper (used by /forgetme confirmations etc. if needed). */
  async sendText(chatId: number, text: string): Promise<void> {
    await this.bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
  }

  // --- internals ----------------------------------------------------------

  private buildCaption(
    header: string,
    profile: SearchProfile,
    listing: Listing,
    includePrice = true,
  ): string {
    const lines: string[] = [header, '', `<b>${esc(listing.title)}</b>`];

    if (includePrice) {
      lines.push(`💰 ${this.formatPrice(listing.price, listing.currency)}`);
    }
    if (listing.area != null) {
      lines.push(`📐 ${listing.area} м²`);
    }
    const where = [listing.city, listing.district].filter(Boolean).map(esc).join(', ');
    if (where) {
      lines.push(`📍 ${where}`);
    }
    lines.push(
      `👤 ${listing.isBusiness ? 'Ріелтор/агенція' : 'Власник'}   🌐 ${esc(listing.sourceLabel)}`,
    );
    lines.push('');
    lines.push(`🔎 Пошук: ${esc(profile.name)}`);
    lines.push(`<a href="${esc(listing.url)}">Відкрити на ${esc(listing.sourceLabel)} ↗</a>`);

    return lines.join('\n');
  }

  private formatPrice(price: number | null, currency: string): string {
    if (price == null) return 'Ціна договірна';
    // Thousands separated by a non-breaking space, uk-style.
    const grouped = price.toLocaleString('uk-UA').replace(/ /g, ' ');
    return `${grouped} ${esc(currency)}`;
  }

  /**
   * Try to send with a thumbnail; fall back to a plain text message if the
   * photo can't be sent (bad/blocked image URL). Throws only if both fail so
   * the caller can avoid marking the listing seen.
   */
  private async send(chatId: number, caption: string, imageUrl?: string): Promise<void> {
    if (imageUrl) {
      try {
        await this.bot.telegram.sendPhoto(chatId, imageUrl, {
          caption,
          parse_mode: 'HTML',
        });
        return;
      } catch (err) {
        this.logger.warn(
          `sendPhoto failed for chat ${chatId} (${(err as Error).message}); falling back to text`,
        );
      }
    }
    await this.bot.telegram.sendMessage(chatId, caption, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: false },
    });
  }
}
