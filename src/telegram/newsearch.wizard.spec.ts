import { NewSearchWizard } from './newsearch.wizard';

const makeCtx = () => ({
  scene: { state: {} as any, leave: jest.fn().mockResolvedValue(undefined) },
  from: { id: 7 },
  chat: { id: 7 },
  message: { text: '' } as { text: string },
  reply: jest.fn().mockResolvedValue(undefined),
});

const build = (existing: any = null) => {
  const profiles = {
    findByUserAndSource: jest.fn().mockResolvedValue(existing),
    upsertForSource: jest.fn().mockResolvedValue({
      id: 'x',
      source: 'domria',
      name: 'DOM.RIA · Київ',
      criteria: { city: 'Київ', ownerOnly: false },
      paused: false,
      primed: false,
      userId: 7,
      chatId: 7,
      createdAt: 0,
    }),
  };
  return { wizard: new NewSearchWizard(profiles as any), profiles };
};

const feed = async (wizard: NewSearchWizard, ctx: any, text: string) => {
  ctx.message = { text };
  await wizard.onText(ctx as any);
};

describe('NewSearchWizard', () => {
  it('completes the flow and upserts a DOM.RIA filter', async () => {
    const { wizard, profiles } = build();
    const ctx = makeCtx();
    await wizard.onEnter(ctx as any);
    expect(ctx.scene.state.stage).toBe('site');

    await feed(wizard, ctx, '🟢 DOM.RIA');
    expect(ctx.scene.state).toMatchObject({ source: 'domria', stage: 'operation' });

    await feed(wizard, ctx, '🔑 Довгострокова оренда');
    expect(ctx.scene.state).toMatchObject({ operation: 'rent', stage: 'city' });

    await feed(wizard, ctx, '🏙 Київ');
    expect(ctx.scene.state).toMatchObject({ city: 'Київ', stage: 'rooms' });

    await feed(wizard, ctx, '2');
    expect(ctx.scene.state).toMatchObject({ rooms: 2, stage: 'price' });

    await feed(wizard, ctx, 'до 20000');
    expect(ctx.scene.state).toMatchObject({ priceMax: 20000, stage: 'area' });

    await feed(wizard, ctx, '30–60');
    expect(profiles.upsertForSource).toHaveBeenCalledWith(
      7,
      7,
      'domria',
      expect.objectContaining({
        operation: 'rent',
        city: 'Київ',
        rooms: 2,
        priceMax: 20000,
        areaMin: 30,
        areaMax: 60,
        ownerOnly: false,
      }),
      expect.any(String),
    );
    expect(ctx.scene.leave).toHaveBeenCalled();
  });

  it('handles 4+ rooms and the sale operation', async () => {
    const { wizard } = build();
    const ctx = makeCtx();
    await wizard.onEnter(ctx as any);
    await feed(wizard, ctx, '🟢 DOM.RIA');
    await feed(wizard, ctx, '🏢 Продаж');
    expect(ctx.scene.state.operation).toBe('sale');
    await feed(wizard, ctx, 'Київ');
    await feed(wizard, ctx, '4+');
    expect(ctx.scene.state.rooms).toBe(4);
  });

  it('routes to Rieltor when that site is chosen', async () => {
    const { wizard, profiles } = build();
    const ctx = makeCtx();
    await wizard.onEnter(ctx as any);
    await feed(wizard, ctx, '🔵 Rieltor');
    expect(ctx.scene.state).toMatchObject({ source: 'rieltor', stage: 'operation' });

    await feed(wizard, ctx, '🔑 Довгострокова оренда');
    await feed(wizard, ctx, '🏙 Київ');
    await feed(wizard, ctx, 'Будь-яка');
    await feed(wizard, ctx, 'до 20000');
    await feed(wizard, ctx, 'до 80');
    expect(profiles.upsertForSource).toHaveBeenCalledWith(
      7,
      7,
      'rieltor',
      expect.objectContaining({ city: 'Київ', operation: 'rent' }),
      expect.stringContaining('Rieltor'),
    );
  });

  it('re-asks on an unrecognized site', async () => {
    const { wizard } = build();
    const ctx = makeCtx();
    ctx.scene.state = { stage: 'site' };
    await feed(wizard, ctx, 'щось');
    expect(ctx.scene.state.stage).toBe('site');
    expect(ctx.scene.state.source).toBeUndefined();
  });

  it('"будь-яка" rooms clears the filter', async () => {
    const { wizard } = build();
    const ctx = makeCtx();
    ctx.scene.state = { stage: 'rooms', operation: 'rent', city: 'Київ' };
    await feed(wizard, ctx, 'Будь-яка');
    expect(ctx.scene.state.rooms).toBeUndefined();
    expect(ctx.scene.state.stage).toBe('price');
  });

  it('supports manual price and area via "Інше"', async () => {
    const { wizard } = build();
    const ctx = makeCtx();
    ctx.scene.state = { stage: 'price' };
    await feed(wizard, ctx, '✏️ Інше');
    expect(ctx.scene.state.stage).toBe('priceManual');
    await feed(wizard, ctx, 'від 5000 до 15000');
    expect(ctx.scene.state).toMatchObject({ priceMin: 5000, priceMax: 15000, stage: 'area' });
    await feed(wizard, ctx, '✏️ Інше');
    expect(ctx.scene.state.stage).toBe('areaManual');
    await feed(wizard, ctx, 'до 90');
    expect(ctx.scene.state.areaMax).toBe(90);
  });

  it('rejects a non-Kyiv city', async () => {
    const { wizard } = build();
    const ctx = makeCtx();
    ctx.scene.state = { stage: 'city', operation: 'rent' };
    await feed(wizard, ctx, 'Львів');
    expect(ctx.scene.state.stage).toBe('city');
    expect(ctx.scene.state.city).toBeUndefined();
  });

  it('re-asks on an unrecognized operation', async () => {
    const { wizard } = build();
    const ctx = makeCtx();
    ctx.scene.state = { stage: 'operation' };
    await feed(wizard, ctx, 'щось');
    expect(ctx.scene.state.stage).toBe('operation');
  });

  it('flags editing when a filter already exists for the chosen site', async () => {
    const { wizard } = build({ id: 'x', source: 'domria' });
    const ctx = makeCtx();
    await wizard.onEnter(ctx as any);
    await feed(wizard, ctx, '🟢 DOM.RIA');
    expect(ctx.scene.state.editing).toBe(true);
  });

  it('/cancel leaves the scene', async () => {
    const { wizard } = build();
    const ctx = makeCtx();
    ctx.scene.state = { stage: 'price' };
    await feed(wizard, ctx, '/cancel');
    expect(ctx.scene.leave).toHaveBeenCalled();
  });

  it('resets on an unknown stage', async () => {
    const { wizard } = build();
    const ctx = makeCtx();
    ctx.scene.state = { stage: 'bogus' };
    await feed(wizard, ctx, 'x');
    expect(ctx.scene.state.stage).toBe('site');
  });
});
