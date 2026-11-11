const test = require('node:test');
const assert = require('node:assert');
const { vytvoritKlienta, teloZasilky, bezDiakritiky, stav } = require('../lib/ppl');

const ENV = {
  PPL_API_URL: 'https://api-dev.dhl.com/ecs/ppl/myapi2/',
  PPL_CLIENT_ID: 'id',
  PPL_CLIENT_SECRET: 'tajne'
};
const BATCH = '11111111-2222-3333-4444-555555555555';

function odpoved(status, { json, text, headers = {}, binary } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: h => headers[h.toLowerCase()] || null },
    json: async () => json,
    text: async () => text || JSON.stringify(json || ''),
    arrayBuffer: async () => binary
  };
}

test('bez diakritiky a jen ASCII', () => {
  assert.strictEqual(bezDiakritiky('Dětské krůčky – Hulín 🙂'), 'Detske krucky Hulin');
  assert.strictEqual(bezDiakritiky('Škarpichová', 5), 'Skarp');
});

test('stav: chybějící proměnné a cizí adresa API', () => {
  assert.match(stav({}).problem, /PPL_CLIENT_ID/);
  assert.match(stav({ ...ENV, PPL_API_URL: 'https://zly.example.com' }).problem, /PPL_API_URL/);
  assert.strictEqual(stav(ENV).prostredi, 'test');
  assert.strictEqual(stav(ENV).problem, null);
  assert.ok(!JSON.stringify(stav(ENV)).includes('tajne'));
});

test('tělo zásilky: PDF A4, adresy bez diakritiky, PSČ bez mezer, dobírka', () => {
  const t = teloZasilky({
    referenceId: '2026123',
    prijemce: { name: 'Jana Nováková', street: 'Dlouhá 5', city: 'Brno', zipCode: '602 00' },
    dobirka: { castka: 990 },
    produkt: 'PRID'
  });
  assert.strictEqual(t.labelSettings.format, 'Pdf');
  assert.strictEqual(t.labelSettings.completeLabelSettings.pageSize, 'A4');
  const z = t.shipments[0];
  assert.strictEqual(z.productType, 'PRID');
  assert.strictEqual(z.recipient.name, 'Jana Novakova');
  assert.strictEqual(z.recipient.zipCode, '60200');
  assert.strictEqual(z.recipient.country, 'CZ');
  assert.deepStrictEqual(z.cashOnDelivery, { codCurrency: 'CZK', codPrice: 990, codVarSym: '2026123' });
  assert.ok(/^[\x20-\x7E]*$/.test(JSON.stringify(t)));
  assert.throws(() => teloZasilky({ prijemce: { zipCode: '1' } }), /referenceId/);
});

test('celý průběh: token (jednou), POST, čekání na Complete, PDF', async () => {
  const volani = [];
  let dotazuNaStav = 0;
  const fetchFn = async (url, m = {}) => {
    volani.push({ url, m });
    if (url.endsWith('/login/getAccessToken')) {
      assert.match(m.body, /grant_type=client_credentials/);
      assert.match(m.body, /scope=myapi2/);
      return odpoved(200, { json: { access_token: 'TOK', expires_in: 1800 } });
    }
    assert.strictEqual(m.headers.Authorization, 'Bearer TOK');
    if (url.endsWith('/shipment/batch') && m.method === 'POST') {
      return odpoved(201, { headers: { location: 'https://api-dev.dhl.com/ecs/ppl/myapi2/shipment/batch/' + BATCH } });
    }
    if (url.endsWith('/shipment/batch/' + BATCH)) {
      dotazuNaStav++;
      const stavImportu = dotazuNaStav < 2 ? 'InProcess' : 'Complete';
      return odpoved(200, { json: { items: [{ shipmentNumber: '80050527927', importState: stavImportu }] } });
    }
    if (url.includes('/shipment/batch/' + BATCH + '/label?')) {
      assert.match(url, /pageSize=A4/);
      return odpoved(200, { binary: Buffer.from('%PDF-1.4 test') });
    }
    throw new Error('Neočekávané volání ' + url);
  };
  const ppl = vytvoritKlienta({ env: ENV, fetchFn, cekej: async () => {} });
  const r = await ppl.zasilkaSEtiketou({ referenceId: 'X1', prijemce: { name: 'A', zipCode: '11000' } });
  assert.strictEqual(r.batchId, BATCH);
  assert.deepStrictEqual(r.cislaZasilek, ['80050527927']);
  assert.strictEqual(r.pdf.toString().slice(0, 5), '%PDF-');
  assert.strictEqual(volani.filter(v => v.url.endsWith('getAccessToken')).length, 1);
  assert.ok(volani.every(v => v.url.startsWith('https://api-dev.dhl.com/ecs/ppl/myapi2/')));
});

test('chyba importu se ohlásí se zprávou od PPL', async () => {
  const fetchFn = async url => {
    if (url.endsWith('getAccessToken')) return odpoved(200, { json: { access_token: 'T', expires_in: 1800 } });
    return odpoved(200, { json: { items: [{ importState: 'Error', errorMessage: 'Invalid zipCode' }] } });
  };
  const ppl = vytvoritKlienta({ env: ENV, fetchFn, cekej: async () => {} });
  await assert.rejects(ppl.cekatNaDavku(BATCH), /Invalid zipCode/);
});

test('bez konfigurace nic nevolá', async () => {
  let volano = false;
  const ppl = vytvoritKlienta({ env: {}, fetchFn: async () => { volano = true; } });
  await assert.rejects(ppl.ziskatToken(), /PPL_CLIENT_ID/);
  assert.strictEqual(volano, false);
});
