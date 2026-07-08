import { Logger } from '@nestjs/common';
import { Command, Ctx, On, Scene, SceneEnter } from 'nestjs-telegraf';
import { Markup, Scenes } from 'telegraf';
import { SearchCriteria } from '../sources/listing.interface';
import { SearchProfilesService } from '../search-profiles/search-profiles.service';
import { CANCELLED, describeProfile } from './telegram.copy';
import { parseRange } from './parsing.util';

export const NEWSEARCH_SCENE = 'newsearch';

// `/newsearch` configures one filter per site (per-site filters). The user picks
// the site first; the rest of the flow is shared. The model is source-scoped, so
// adding a site = a button here + a source spec.
const SITE_LABELS: Record<string, string> = { domria: 'DOM.RIA', rieltor: 'Rieltor' };

// --- button labels ---------------------------------------------------------
const SITE_DOMRIA = '🟢 DOM.RIA';
const SITE_RIELTOR = '🔵 Rieltor';
const OP_RENT = '🔑 Довгострокова оренда';
const OP_SALE = '🏢 Продаж';
const CITY_KYIV = '🏙 Київ';
const ROOMS_ANY = 'Будь-яка';
const OTHER = '✏️ Інше';

type Stage =
  | 'site'
  | 'operation'
  | 'city'
  | 'rooms'
  | 'price'
  | 'priceManual'
  | 'area'
  | 'areaManual';

interface WizardState {
  stage: Stage;
  source?: string;
  editing?: boolean;
  operation?: 'rent' | 'sale';
  city?: string;
  rooms?: number;
  priceMin?: number;
  priceMax?: number;
  areaMin?: number;
  areaMax?: number;
}

const HTML = { parse_mode: 'HTML' as const };

/**
 * New-search wizard — a small state machine. One filter per site:
 *   site [DOM.RIA | Rieltor] → operation [оренда | продаж] → city [Київ]
 *   → rooms [1|2|3|4+|будь-яка] → price → area → save.
 * Re-running for a site edits (overwrites) that site's existing filter.
 */
@Scene(NEWSEARCH_SCENE)
export class NewSearchWizard {
  private readonly logger = new Logger(NewSearchWizard.name);

  constructor(private readonly profiles: SearchProfilesService) {}

  @SceneEnter()
  async onEnter(@Ctx() ctx: Scenes.SceneContext) {
    const st = this.state(ctx);
    st.stage = 'site';
    await ctx.reply(
      '🆕 Новий фільтр. Спершу оберіть <b>сайт</b> (на кожен сайт — один фільтр).\n' +
        'У будь-який момент — /cancel.\n\n1️⃣ <b>Сайт</b>?',
      { ...HTML, ...Markup.keyboard([[SITE_DOMRIA, SITE_RIELTOR]]).oneTime().resize() },
    );
  }

  @Command('cancel')
  async onCancel(@Ctx() ctx: Scenes.SceneContext) {
    await ctx.reply(CANCELLED, Markup.removeKeyboard());
    await ctx.scene.leave();
  }

  @On('text')
  async onText(@Ctx() ctx: Scenes.SceneContext) {
    const text = this.text(ctx);
    if (text.toLowerCase() === '/cancel') return this.onCancel(ctx);
    const st = this.state(ctx);
    switch (st.stage) {
      case 'site':
        return this.handleSite(ctx, st, text);
      case 'operation':
        return this.handleOperation(ctx, st, text);
      case 'city':
        return this.handleCity(ctx, st, text);
      case 'rooms':
        return this.handleRooms(ctx, st, text);
      case 'price':
        return this.handlePrice(ctx, st, text);
      case 'priceManual':
        return this.handlePriceManual(ctx, st, text);
      case 'area':
        return this.handleArea(ctx, st, text);
      case 'areaManual':
        return this.handleAreaManual(ctx, st, text);
      default:
        return this.onEnter(ctx);
    }
  }

  // --- stage handlers -----------------------------------------------------

  private async handleSite(ctx: Scenes.SceneContext, st: WizardState, text: string) {
    const t = text.toLowerCase();
    if (t.includes('dom') || t.includes('дом')) st.source = 'domria';
    else if (t.includes('rieltor') || t.includes('ріел') || t.includes('риел')) st.source = 'rieltor';
    else {
      await ctx.reply(`Оберіть сайт кнопкою: «${SITE_DOMRIA}» або «${SITE_RIELTOR}».`);
      return;
    }

    const existing = await this.profiles.findByUserAndSource(ctx.from?.id as number, st.source);
    st.editing = Boolean(existing);
    const label = SITE_LABELS[st.source];
    const intro = existing
      ? `✏️ Оновлюємо твій фільтр <b>${label}</b>. Відповідай наново.\n\n`
      : `🆕 Новий фільтр <b>${label}</b>.\n\n`;
    st.stage = 'operation';
    await ctx.reply(intro + '2️⃣ Тип <b>операції</b>?', {
      ...HTML,
      ...Markup.keyboard([[OP_RENT], [OP_SALE]]).oneTime().resize(),
    });
  }

  private async handleOperation(ctx: Scenes.SceneContext, st: WizardState, text: string) {
    const t = text.toLowerCase();
    if (t.includes('оренд') || t.includes('rent')) st.operation = 'rent';
    else if (t.includes('продаж') || t.includes('sale')) st.operation = 'sale';
    else {
      await ctx.reply(`Оберіть кнопкою: «${OP_RENT}» або «${OP_SALE}».`);
      return;
    }
    st.stage = 'city';
    await ctx.reply('3️⃣ <b>Місто</b>? (поки доступний лише Київ)', {
      ...HTML,
      ...Markup.keyboard([[CITY_KYIV]]).oneTime().resize(),
    });
  }

  private async handleCity(ctx: Scenes.SceneContext, st: WizardState, text: string) {
    if (!/київ/i.test(text)) {
      await ctx.reply('Поки доступний лише Київ. Натисніть «🏙 Київ».');
      return;
    }
    st.city = 'Київ';
    st.stage = 'rooms';
    await ctx.reply('4️⃣ Скільки <b>кімнат</b>?', {
      ...HTML,
      ...Markup.keyboard([['1', '2', '3', '4+'], [ROOMS_ANY]]).oneTime().resize(),
    });
  }

  private async handleRooms(ctx: Scenes.SceneContext, st: WizardState, text: string) {
    const t = text.trim().toLowerCase();
    if (/будь/.test(t)) st.rooms = undefined;
    else if (t.startsWith('4')) st.rooms = 4;
    else if (t === '1' || t === '2' || t === '3') st.rooms = Number.parseInt(t, 10);
    else {
      await ctx.reply('Оберіть кількість кімнат кнопкою (1, 2, 3, 4+ або «Будь-яка»).');
      return;
    }
    await this.askPrice(ctx, st);
  }

  private async handlePrice(ctx: Scenes.SceneContext, st: WizardState, text: string) {
    if (text === OTHER || /^інше/i.test(text)) {
      st.stage = 'priceManual';
      await ctx.reply(
        'Введіть <b>ціну</b> (грн): напр. <code>від 5000 до 15000</code>, <code>до 20000</code> ' +
          'або <code>-</code> щоб не обмежувати.',
        { ...HTML, ...Markup.removeKeyboard() },
      );
      return;
    }
    this.applyPrice(st, text);
    await this.askArea(ctx, st);
  }

  private async handlePriceManual(ctx: Scenes.SceneContext, st: WizardState, text: string) {
    this.applyPrice(st, text);
    await this.askArea(ctx, st);
  }

  private async handleArea(ctx: Scenes.SceneContext, st: WizardState, text: string) {
    if (text === OTHER || /^інше/i.test(text)) {
      st.stage = 'areaManual';
      await ctx.reply(
        'Введіть <b>площу</b> (м²): напр. <code>від 30 до 60</code>, <code>до 80</code> ' +
          'або <code>-</code> щоб не обмежувати.',
        { ...HTML, ...Markup.removeKeyboard() },
      );
      return;
    }
    this.applyArea(st, text);
    await this.save(ctx, st);
  }

  private async handleAreaManual(ctx: Scenes.SceneContext, st: WizardState, text: string) {
    this.applyArea(st, text);
    await this.save(ctx, st);
  }

  private async save(ctx: Scenes.SceneContext, st: WizardState) {
    const criteria: SearchCriteria = {
      operation: st.operation ?? 'rent',
      city: st.city as string,
      rooms: st.rooms,
      priceMin: st.priceMin,
      priceMax: st.priceMax,
      areaMin: st.areaMin,
      areaMax: st.areaMax,
      ownerOnly: false,
    };
    const source = st.source ?? 'domria';
    const label = SITE_LABELS[source] ?? source;
    const roomsPart = st.rooms != null ? ` · ${st.rooms >= 4 ? '4+' : st.rooms}-кімн.` : '';
    const opPart = st.operation === 'sale' ? 'продаж' : 'оренда';
    const name = `${label} · ${st.city} · ${opPart}${roomsPart}`;

    const userId = ctx.from?.id as number;
    const chatId = ctx.chat?.id as number;
    const profile = await this.profiles.upsertForSource(userId, chatId, source, criteria, name);

    await ctx.reply(
      `✅ <b>Фільтр ${st.editing ? 'оновлено' : 'збережено'}!</b>\n\n` +
        describeProfile(profile) +
        '\n\nПочну перевіряти найближчим часом. Керувати — /mysearches',
      { ...HTML, ...Markup.removeKeyboard() },
    );
    this.logger.log(`newsearch(${source}) done: profile ${profile.id} for user ${userId}`);
    await ctx.scene.leave();
  }

  // --- shared prompts -----------------------------------------------------

  private async askPrice(ctx: Scenes.SceneContext, st: WizardState) {
    st.stage = 'price';
    await ctx.reply('5️⃣ Оберіть <b>ціну</b> (грн) або «Інше» для ручного вводу:', {
      ...HTML,
      ...Markup.keyboard([['до 10000', 'до 20000', 'до 30000'], [OTHER]]).oneTime().resize(),
    });
  }

  private async askArea(ctx: Scenes.SceneContext, st: WizardState) {
    st.stage = 'area';
    await ctx.reply('6️⃣ Оберіть <b>площу</b> (м²) або «Інше» для ручного вводу:', {
      ...HTML,
      ...Markup.keyboard([['30–60', 'до 45', 'до 80'], [OTHER]]).oneTime().resize(),
    });
  }

  private applyPrice(st: WizardState, text: string) {
    const { min, max } = parseRange(text);
    st.priceMin = min;
    st.priceMax = max;
  }

  private applyArea(st: WizardState, text: string) {
    const { min, max } = parseRange(text);
    st.areaMin = min;
    st.areaMax = max;
  }

  // --- helpers ------------------------------------------------------------

  private text(ctx: Scenes.SceneContext): string {
    const msg = ctx.message as { text?: string } | undefined;
    return (msg?.text ?? '').trim();
  }

  private state(ctx: Scenes.SceneContext): WizardState {
    return ctx.scene.state as WizardState;
  }
}
