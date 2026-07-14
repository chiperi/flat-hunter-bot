import { SearchProfile } from '../search-profiles/search-profile.model';

/**
 * All user-facing bot copy in one place. Ukrainian by default (per the brief).
 * Uses HTML parse mode everywhere — only `< > &` need escaping (see `esc`).
 */

export const ACCESS_RESTRICTED =
  '⛔️ Доступ обмежено. Цей бот працює лише для дозволеного кола користувачів.\n' +
  'Якщо вважаєте, що це помилка — зверніться до адміністратора.';

export const WELCOME =
  '👋 <b>Flat Hunter</b> — стежу за оголошеннями оренди й продажу житла та миттєво ' +
  'пишу, щойно з’являється щось нове за вашим фільтром. Один пошук перевіряє одразу ' +
  'кілька сайтів (<b>DOM.RIA</b> і <b>Rieltor</b>), а в кожному сповіщенні видно джерело.\n\n' +
  '<b>Команди:</b>\n' +
  '• /newsearch — налаштувати пошук (майстер крок за кроком)\n' +
  '• /mysearches — переглянути та керувати пошуком\n' +
  '• /pause <code>id</code> — призупинити пошук\n' +
  '• /resume <code>id</code> — відновити пошук\n' +
  '• /forgetme — видалити всі мої дані\n' +
  '• /help — показати цю довідку\n\n' +
  'Почнімо: надішліть /newsearch 🔎';

export const HELP = WELCOME;

export const CANCELLED = '❌ Скасовано. Нічого не збережено.';

/**
 * Escape for Telegram HTML parse mode. Includes `"` (→ `&quot;`) because esc()'s
 * output is also used inside `href="..."` attributes (telegram.service.ts); a
 * scraped URL with a literal quote would otherwise break the tag and fail the
 * send permanently (the scheduler retries the same bad URL forever). `&quot;`
 * renders correctly in text context too, so escaping it everywhere is safe.
 */
export function esc(input: unknown): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtRange(min?: number, max?: number, unit = ''): string {
  const u = unit ? ` ${unit}` : '';
  if (min != null && max != null) return `${min}–${max}${u}`;
  if (min != null) return `від ${min}${u}`;
  if (max != null) return `до ${max}${u}`;
  return 'будь-яка';
}

/** One-line human summary of a profile's filters, for lists and confirmations. */
export function describeProfile(p: SearchProfile): string {
  const c = p.criteria;
  const where = c.district ? `${esc(c.city)}, ${esc(c.district)}` : esc(c.city);
  const op = c.operation === 'sale' ? 'продаж' : 'довгострокова оренда';
  const price = fmtRange(c.priceMin, c.priceMax, 'грн');
  const area = fmtRange(c.areaMin, c.areaMax, 'м²');
  const status = p.paused ? '⏸ призупинено' : '▶️ активний';

  const lines = [
    `🔎 <b>${esc(p.name)}</b>  <code>${esc(p.id)}</code>`,
    `   🌐 усі сайти   ${op}`,
    `   📍 ${where}`,
  ];
  if (c.rooms != null) lines.push(`   🚪 ${c.rooms >= 4 ? '4+' : c.rooms}-кімн.`);
  lines.push(`   💰 ${price}   📐 ${area}`);
  if (c.ownerOnly) lines.push('   👤 лише власники');
  lines.push(`   ${status}`);
  return lines.join('\n');
}

export const NO_SEARCHES =
  'У вас поки немає активних пошуків. Створіть перший — /newsearch 🔎';
