import { Logger } from '@nestjs/common';
import { Ctx, Wizard, WizardStep } from 'nestjs-telegraf';
import { Markup, Scenes } from 'telegraf';
import { SearchCriteria } from '../sources/listing.interface';
import { SearchProfilesService } from '../search-profiles/search-profiles.service';
import { CANCELLED, describeProfile } from './telegram.copy';
import {
  INCLUDE_ALL_LABEL,
  OWNER_ONLY_LABEL,
  parseOptionalText,
  parseOwnerChoice,
  parseRange,
} from './parsing.util';

export const NEWSEARCH_SCENE = 'newsearch';

interface WizardState {
  city?: string;
  district?: string;
  priceMin?: number;
  priceMax?: number;
  areaMin?: number;
  areaMax?: number;
}

/**
 * Step-by-step /newsearch wizard:
 *   city → district → price → area → owner-only → save.
 *
 * Telegraf wizard mechanics: step 1 runs on enter and advances the cursor; each
 * later step consumes the user's next message. On invalid input a step re-asks
 * WITHOUT advancing, so the user simply retries. `/cancel` bails out anywhere.
 */
@Wizard(NEWSEARCH_SCENE)
export class NewSearchWizard {
  private readonly logger = new Logger(NewSearchWizard.name);

  constructor(private readonly profiles: SearchProfilesService) {}

  private text(ctx: Scenes.WizardContext): string {
    const msg = ctx.message as { text?: string } | undefined;
    return (msg?.text ?? '').trim();
  }

  private state(ctx: Scenes.WizardContext): WizardState {
    return ctx.wizard.state as WizardState;
  }

  /** True (and leaves the scene) if the user typed /cancel. */
  private async bailIfCancelled(ctx: Scenes.WizardContext): Promise<boolean> {
    if (this.text(ctx).toLowerCase() === '/cancel') {
      await ctx.reply(CANCELLED, Markup.removeKeyboard());
      await ctx.scene.leave();
      return true;
    }
    return false;
  }

  @WizardStep(1)
  async stepStart(@Ctx() ctx: Scenes.WizardContext) {
    await ctx.reply(
      '🆕 <b>Новий пошук.</b> Відповідайте на кілька запитань.\n' +
        'У будь-який момент надішліть /cancel, щоб скасувати.\n\n' +
        '1️⃣ У якому <b>місті</b> шукаємо? (напр. <i>Київ</i>)',
      { parse_mode: 'HTML' },
    );
    ctx.wizard.next();
  }

  @WizardStep(2)
  async stepCity(@Ctx() ctx: Scenes.WizardContext) {
    if (await this.bailIfCancelled(ctx)) return;
    const city = this.text(ctx);
    if (!city) {
      await ctx.reply('Будь ласка, введіть назву міста текстом. (напр. Київ)');
      return; // stay on this step
    }
    this.state(ctx).city = city;
    await ctx.reply(
      '2️⃣ <b>Район</b>? Введіть район/мікрорайон або надішліть <code>-</code>, ' +
        'щоб шукати по всьому місту.',
      { parse_mode: 'HTML' },
    );
    ctx.wizard.next();
  }

  @WizardStep(3)
  async stepDistrict(@Ctx() ctx: Scenes.WizardContext) {
    if (await this.bailIfCancelled(ctx)) return;
    this.state(ctx).district = parseOptionalText(this.text(ctx));
    await ctx.reply(
      '3️⃣ <b>Ціна</b> (грн)? Формати: <code>5000-15000</code>, <code>до 15000</code>, ' +
        '<code>від 5000</code> або <code>-</code> щоб не обмежувати.',
      { parse_mode: 'HTML' },
    );
    ctx.wizard.next();
  }

  @WizardStep(4)
  async stepPrice(@Ctx() ctx: Scenes.WizardContext) {
    if (await this.bailIfCancelled(ctx)) return;
    const { min, max } = parseRange(this.text(ctx));
    const st = this.state(ctx);
    st.priceMin = min;
    st.priceMax = max;
    await ctx.reply(
      '4️⃣ <b>Площа</b> (м²)? Формати: <code>30-60</code>, <code>від 40</code>, ' +
        '<code>до 80</code> або <code>-</code> щоб не обмежувати.',
      { parse_mode: 'HTML' },
    );
    ctx.wizard.next();
  }

  @WizardStep(5)
  async stepArea(@Ctx() ctx: Scenes.WizardContext) {
    if (await this.bailIfCancelled(ctx)) return;
    const { min, max } = parseRange(this.text(ctx));
    const st = this.state(ctx);
    st.areaMin = min;
    st.areaMax = max;
    await ctx.reply(
      '5️⃣ Показувати оголошення <b>лише від власників</b> чи також від ріелторів?',
      Markup.keyboard([[OWNER_ONLY_LABEL], [INCLUDE_ALL_LABEL]])
        .oneTime()
        .resize(),
    );
    ctx.wizard.next();
  }

  @WizardStep(6)
  async stepOwner(@Ctx() ctx: Scenes.WizardContext) {
    if (await this.bailIfCancelled(ctx)) return;
    const ownerOnly = parseOwnerChoice(this.text(ctx));
    if (ownerOnly === null) {
      await ctx.reply(
        `Оберіть одну з кнопок: «${OWNER_ONLY_LABEL}» або «${INCLUDE_ALL_LABEL}».`,
      );
      return; // stay on this step
    }

    const st = this.state(ctx);
    const criteria: SearchCriteria = {
      city: st.city as string,
      district: st.district,
      priceMin: st.priceMin,
      priceMax: st.priceMax,
      areaMin: st.areaMin,
      areaMax: st.areaMax,
      ownerOnly,
    };

    const userId = ctx.from?.id as number;
    const chatId = ctx.chat?.id as number;
    const profile = await this.profiles.create(userId, chatId, criteria);

    await ctx.reply(
      '✅ <b>Пошук збережено!</b>\n\n' +
        describeProfile(profile) +
        '\n\nПочну перевіряти найближчим часом і напишу, щойно з’явиться щось нове. ' +
        'Керувати пошуками — /mysearches',
      { parse_mode: 'HTML', ...Markup.removeKeyboard() },
    );
    this.logger.log(`Wizard completed: profile ${profile.id} for user ${userId}`);
    await ctx.scene.leave();
  }
}
