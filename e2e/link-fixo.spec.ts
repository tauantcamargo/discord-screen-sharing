import { test, expect, shareScreen, videoCount, invite, type User } from './fixtures';

/**
 * Link fixo, `/s/<nome>`: o endereço que se fixa num canal do Discord. Quem
 * abre cai direto na sala, sem lobby, e a sala não aparece na lista pública.
 */
const slug = () => `teste-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

async function abrir(user: User, nome: string) {
  await user.page.goto(`/s/${nome}`);
  await user.page.getByRole('button', { name: 'Entrar como convidado' }).click();
  await expect(user.page.getByRole('button', { name: 'Sair da sala' })).toBeVisible();
}

test.describe('link fixo', () => {
  test('dois convidados no mesmo link: mesma sala, transmite e assiste', async ({ spawn }) => {
    const ana = await spawn('Ana');
    const bia = await spawn('Bia');
    const nome = slug();

    await abrir(ana, nome);
    await abrir(bia, nome);

    await shareScreen(ana);
    await invite(bia).click();
    await expect.poll(() => videoCount(bia), { timeout: 15_000 }).toBe(1);
  });

  test('não aparece no lobby, e a escolha de convidado vale para a aba', async ({ spawn }) => {
    const ana = await spawn('Ana');
    const caio = await spawn('Caio');
    const nome = slug();

    await abrir(ana, nome);

    await caio.page.goto('/');
    await expect(caio.page.getByText(nome.replace(/-+/g, ' '), { exact: false })).toHaveCount(0);

    // Recarregar não pergunta de novo: entra direto.
    await ana.page.reload();
    await expect(ana.page.getByRole('button', { name: 'Sair da sala' })).toBeVisible();
  });

  test('nome fora do formato dá 404', async ({ spawn }) => {
    const ana = await spawn('Ana');
    ana.allow(/404|Failed to load resource/);
    const r = await ana.page.goto('/s/Nome_Com%20Espaco');
    expect(r?.status()).toBe(404);
  });
});
