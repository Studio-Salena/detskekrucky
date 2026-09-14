// Zákazník má dostat informační e-mail při přechodu objednávky do stavu
// "vyrizuje" / "zaplacena" / "odeslana" - ne u ostatních stavů, a ne když se
// uloží stejný stav znovu (žádné duplicitní e-maily).
const test = require('node:test');
const assert = require('node:assert/strict');
const { nacistRouterSMocky, najitHandler, vytvoritRes, vytvoritMockPool, pocatecniStav } = require('../test-helpers/_pomocnik');

function pripravitHandler(stav, zachyceneEmaily) {
  const pool = vytvoritMockPool(stav);
  const router = nacistRouterSMocky('../routes/objednavky.js', {
    '../db/pool': pool,
    './emaily': {
      odeslat_potvrzeni: async () => {},
      odeslat_upozorneni_objednavky: async () => {},
      odeslat_email_zmena_stavu: async (objednavka, stav) => { zachyceneEmaily.push({ objednavka, stav }); }
    }
  });
  return najitHandler(router, 'patch', '/:id/stav');
}

async function zavolatHandler(handler, id, stav) {
  const req = { params: { id: String(id) }, body: { stav } };
  const res = vytvoritRes();
  await handler(req, res);
  await new Promise(r => setTimeout(r, 0)); // nechat doběhnout fire-and-forget odeslání e-mailu
  return res;
}

function pripravitStav() {
  const stav = pocatecniStav();
  stav.zakaznici.push({ id: 1, jmeno: 'Jana Nováková', email: 'jana@example.com' });
  stav.objednavky.push({ id: 1, zakaznik_id: 1, celkem: 500, poukaz_id: null, sleva: 0, stav: 'nova' });
  return stav;
}

test('přechod do "vyrizuje" pošle zákazníkovi e-mail', async () => {
  const stav = pripravitStav();
  const zachycene = [];
  const handler = pripravitHandler(stav, zachycene);

  await zavolatHandler(handler, 1, 'vyrizuje');

  assert.equal(zachycene.length, 1);
  assert.equal(zachycene[0].stav, 'vyrizuje');
  assert.equal(zachycene[0].objednavka.email, 'jana@example.com');
});

test('přechod do "zaplacena" a "odeslana" taky pošle e-mail', async () => {
  const stav = pripravitStav();
  const zachycene = [];
  const handler = pripravitHandler(stav, zachycene);

  await zavolatHandler(handler, 1, 'zaplacena');
  await zavolatHandler(handler, 1, 'odeslana');

  assert.deepEqual(zachycene.map(z => z.stav), ['zaplacena', 'odeslana']);
});

test('přechod do "dorucena" e-mail nepošle', async () => {
  const stav = pripravitStav();
  const zachycene = [];
  const handler = pripravitHandler(stav, zachycene);

  await zavolatHandler(handler, 1, 'dorucena');

  assert.equal(zachycene.length, 0);
});

test('opakované uložení stejného stavu nepošle e-mail podruhé', async () => {
  const stav = pripravitStav();
  const zachycene = [];
  const handler = pripravitHandler(stav, zachycene);

  await zavolatHandler(handler, 1, 'vyrizuje');
  await zavolatHandler(handler, 1, 'vyrizuje');

  assert.equal(zachycene.length, 1);
});
