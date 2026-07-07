import { SearchProfile } from '../search-profiles/search-profile.model';

/**
 * All user-facing bot copy in one place. Ukrainian by default (per the brief).
 * Uses HTML parse mode everywhere — only `< > &` need escaping (see `esc`).
 */

export const ACCESS_RESTRICTED =
  '⛔️ Доступ обмежено. Цей бот працює лише для дозволеного кола користувачів.\n' +
  'Якщо вважаєте, що це помилка — зверніться до адміністратора.';

export const WELCOME =
  '👋 <b>Flat Hunter</b> — стежу за оголошеннями на OLX і миттєво пишу, щойно ' +
  'з’являється щось нове за вашими фільтрами.\n\n' +
  '<b>Команди:</b>\n' +
  '• /newsearch — створити новий пошук (майстер крок за кроком)\n' +
  '• /mysearches — переглянути та керувати пошуками\n' +
  '• /pause <code>id</code> — призупинити пошук\n' +
  '• /resume <code>id</code> — відновити пошук\n' +
  '• /forgetme — видалити всі мої дані\n' +
  '• /help — показати цю довідку\n\n' +
  'Почнімо: надішліть /newsearch 🔎';

export const HELP = WELCOME;

export const CANCELLED = '❌ Скасовано. Нічого не збережено.';

/** Escape the three characters that matter for Telegram HTML parse mode. */
export function esc(input: unknown): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
  const price = fmtRange(c.priceMin, c.priceMax, 'грн');
  const area = fmtRange(c.areaMin, c.areaMax, 'м²');
  const owner = c.ownerOnly ? 'лише власники' : 'усі (з ріелторами)';
  const status = p.paused ? '⏸ призупинено' : '▶️ активний';
  return (
    `🔎 <b>${esc(p.name)}</b>  <code>${esc(p.id)}</code>\n` +
    `   📍 ${where}\n` +
    `   💰 ${price}   📐 ${area}\n` +
    `   👤 ${owner}   ${status}`
  );
}

export const NO_SEARCHES =
  'У вас поки немає активних пошуків. Створіть перший — /newsearch 🔎';
