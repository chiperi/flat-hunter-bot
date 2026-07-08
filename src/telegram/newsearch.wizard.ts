import { Logger } from '@nestjs/common';
import { Command, Ctx, On, Scene, SceneEnter } from 'nestjs-telegraf';
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

// --- button labels ---------------------------------------------------------
const CITY_KYIV = '🏙 Київ';
const CITY_OTHER = '✏️ Інше місто';
const ANY_DISTRICT = '🏙 Будь-який район';
const AREA_OTHER = '✏️ Інше';
const KYIV_DISTRICTS = [
  'Голосіївський',
  'Дарницький',
  'Деснянський',
  'Дніпровський',
  'Оболонський',
  'Печерський',
  'Подільський',
  'Святошинський',
  'Солом’янський',
  'Шевченківський',
];

type Stage =
  | 'city'
  | 'cityManual'
  | 'districtKyiv'
  | 'districtManual'
  | 'price'
  | 'area'
  | 'areaManual'
  | 'owner';

interface WizardState {
  stage: Stage;
  city?: string;
  district?: string;
  priceMin?: number;
  priceMax?: number;
  areaMin?: number;
  areaMax?: number;
}

const HTML = { parse_mode: 'HTML' as const };

/**
 * /newsearch as a small state machine (a plain scene rather than a strict
 * linear wizard, because the flow branches: Kyiv → district buttons vs. other
 * city → manual entry, and area presets vs. manual). `state.stage` tracks where
 * the user is; each incoming text is routed by it. `/cancel` bails out anywhere.
 *
 * Flow:
 *   city [Київ | Інше місто]
 *     Київ  → district buttons (10 raions + "будь-який")
 *     Інше  → type city → type district
 *   price (free text)
 *   area  [30–60 | до 45 | до 80 | Інше→free text]
 *   owner [лише власники | усі]  → save
 */
@Scene(NEWSEARCH_SCENE)
export class NewSearchWizard {
  private readonly logger = new Logger(NewSearchWizard.name);

  constructor(private readonly profiles: SearchProfilesService) {}

  @SceneEnter()
  async onEnter(@Ctx() ctx: Scenes.SceneContext) {
    const st = this.state(ctx);
    st.stage = 'city';
    await ctx.reply(
      '🆕 <b>Новий пошук.</b> Відповідайте на кілька запитань.\n' +
        'У будь-який момент — /cancel, щоб скасувати.\n\n' +
        '1️⃣ У якому <b>місті</b> шукаємо?',
      { ...HTML, ...Markup.keyboard([[CITY_KYIV], [CITY_OTHER]]).oneTime().resize() },
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
      case 'city':
        return this.handleCity(ctx, st, text);
      case 'cityManual':
        return this.handleCityManual(ctx, st, text);
      case 'districtKyiv':
        return this.handleDistrict(ctx, st, /будь-як/i.test(text) ? undefined : text);
      case 'districtManual':
        return this.handleDistrict(ctx, st, parseOptionalText(text));
      case 'price':
        return this.handlePrice(ctx, st, text);
      case 'area':
        return this.handleArea(ctx, st, text);
      case 'areaManual':
        return this.handleAreaManual(ctx, st, text);
      case 'owner':
        return this.handleOwner(ctx, st, text);
      default:
        return this.onEnter(ctx);
    }
  }

  // --- stage handlers -----------------------------------------------------

  private async handleCity(ctx: Scenes.SceneContext, st: WizardState, text: string) {
    if (/київ/i.test(text)) {
      st.city = 'Київ';
      st.stage = 'districtKyiv';
      await ctx.reply('2️⃣ Оберіть <b>район</b> Києва:', {
        ...HTML,
        ...this.kyivDistrictKeyboard(),
      });
      return;
    }
    if (/інше/i.test(text) || text === CITY_OTHER) {
      st.stage = 'cityManual';
      await ctx.reply('2️⃣ Введіть <b>місто</b> текстом (напр. <i>Львів</i>):', {
        ...HTML,
        ...Markup.removeKeyboard(),
      });
      return;
    }
    // Typed a city name directly — accept it and go to manual district.
    st.city = text;
    await this.askManualDistrict(ctx, st);
  }

  private async handleCityManual(ctx: Scenes.SceneContext, st: WizardState, text: string) {
    if (!text) {
      await ctx.reply('Будь ласка, введіть назву міста текстом.');
      return;
    }
    st.city = text;
    await this.askManualDistrict(ctx, st);
  }

  private async handleDistrict(ctx: Scenes.SceneContext, st: WizardState, district?: string) {
    st.district = district;
    st.stage = 'price';
    await ctx.reply(
      '3️⃣ <b>Ціна</b> (грн)? Формати: <code>5000-15000</code>, <code>до 15000</code>, ' +
        '<code>від 5000</code> або <code>-</code> щоб не обмежувати.',
      { ...HTML, ...Markup.removeKeyboard() },
    );
  }

  private async handlePrice(ctx: Scenes.SceneContext, st: WizardState, text: string) {
    const { min, max } = parseRange(text);
    st.priceMin = min;
    st.priceMax = max;
    st.stage = 'area';
    await ctx.reply('4️⃣ Оберіть <b>площу</b> (м²) або натисніть «Інше», щоб ввести вручну:', {
      ...HTML,
      ...Markup.keyboard([['30–60', 'до 45', 'до 80'], [AREA_OTHER]]).oneTime().resize(),
    });
  }

  private async handleArea(ctx: Scenes.SceneContext, st: WizardState, text: string) {
    if (text === AREA_OTHER || /^інше/i.test(text)) {
      st.stage = 'areaManual';
      await ctx.reply(
        'Введіть <b>площу</b> (м²): <code>30-60</code>, <code>від 40</code>, ' +
          '<code>до 80</code> або <code>-</code> щоб не обмежувати.',
        { ...HTML, ...Markup.removeKeyboard() },
      );
      return;
    }
    this.applyArea(st, text);
    await this.askOwner(ctx, st);
  }

  private async handleAreaManual(ctx: Scenes.SceneContext, st: WizardState, text: string) {
    this.applyArea(st, text);
    await this.askOwner(ctx, st);
  }

  private async handleOwner(ctx: Scenes.SceneContext, st: WizardState, text: string) {
    const ownerOnly = parseOwnerChoice(text);
    if (ownerOnly === null) {
      await ctx.reply(`Оберіть кнопку: «${OWNER_ONLY_LABEL}» або «${INCLUDE_ALL_LABEL}».`);
      return;
    }

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
      { ...HTML, ...Markup.removeKeyboard() },
    );
    this.logger.log(`newsearch completed: profile ${profile.id} for user ${userId}`);
    await ctx.scene.leave();
  }

  // --- shared prompts -----------------------------------------------------

  private async askManualDistrict(ctx: Scenes.SceneContext, st: WizardState) {
    st.stage = 'districtManual';
    await ctx.reply(
      '2️⃣ <b>Район</b>? Введіть район/мікрорайон або надішліть <code>-</code>, ' +
        'щоб шукати по всьому місту.',
      { ...HTML, ...Markup.removeKeyboard() },
    );
  }

  private async askOwner(ctx: Scenes.SceneContext, st: WizardState) {
    st.stage = 'owner';
    await ctx.reply('5️⃣ Показувати оголошення <b>лише від власників</b> чи також від ріелторів?', {
      ...HTML,
      ...Markup.keyboard([[OWNER_ONLY_LABEL], [INCLUDE_ALL_LABEL]]).oneTime().resize(),
    });
  }

  private applyArea(st: WizardState, text: string) {
    const { min, max } = parseRange(text);
    st.areaMin = min;
    st.areaMax = max;
  }

  // --- helpers ------------------------------------------------------------

  private kyivDistrictKeyboard() {
    const rows: string[][] = [];
    for (let i = 0; i < KYIV_DISTRICTS.length; i += 2) {
      rows.push(KYIV_DISTRICTS.slice(i, i + 2));
    }
    rows.push([ANY_DISTRICT]);
    return Markup.keyboard(rows).oneTime().resize();
  }

  private text(ctx: Scenes.SceneContext): string {
    const msg = ctx.message as { text?: string } | undefined;
    return (msg?.text ?? '').trim();
  }

  private state(ctx: Scenes.SceneContext): WizardState {
    return ctx.scene.state as WizardState;
  }
}
