// Zásilkovna API (krok 2): sestavení zásilky, XML požadavek, odpovědi a chyby,
// štítek PDF. Skutečné API se nevolá - fetch je podstrčený.
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../lib/zasilkovnaApi');

const HESLO = 'a'.repeat(16) + 'b'.repeat(16);
const ENV = { ZASILKOVNA_API_HESLO: HESLO };
const OBJ = { id: 7, cislo: '261007', dopravce: 'zasilkovna', vydejni_misto_id: '12345', platba: 'prevod', celkem: '1069',
  obj_jmeno: 'Jana  Marie Nováková', obj_email: 'jana@example.com', obj_telefon: '+420 777 123 456' };
const odpoved = text => async () => ({ text: async () => text });

test('stav: podání jen s API heslem ve správném tvaru, heslo se nikdy nevrací', () => {
  assert.deepEqual(api.stav(ENV), { podani: true, problem: null });
  assert.match(api.stav({}).problem, /chybí proměnná ZASILKOVNA_API_HESLO/);
  const kratke = api.stav({ ZASILKOVNA_API_HESLO: 'abcdef0123456789' });
  assert.equal(kratke.podani, false);
  assert.ok(!JSON.stringify(api.stav(ENV)).includes(HESLO));
});

test('sestavení zásilky z objednávky', () => {
  assert.deepEqual(api.sestavitZasilku(OBJ, 0.8, 'detskekrucky'), {
    number: '261007', name: 'Jana Marie', surname: 'Nováková', email: 'jana@example.com', phone: '+420777123456',
    addressId: '12345', cod: 0, value: 1069, weight: 0.8, eshop: 'detskekrucky'
  });
  assert.throws(() => api.sestavitZasilku({ ...OBJ, dopravce: 'gls' }, 1), /není doprava Zásilkovnou/);
  assert.throws(() => api.sestavitZasilku({ ...OBJ, vydejni_misto_id: null }, 1), /nemá výdejní místo/);
  assert.throws(() => api.sestavitZasilku(OBJ, 0), /Váha/);
  assert.throws(() => api.sestavitZasilku(OBJ, 31), /Váha/);
  assert.throws(() => api.sestavitZasilku({ ...OBJ, obj_email: '', obj_telefon: '' }, 1), /kontakt/);
});

test('podání: XML s escapováním, heslo jen v těle požadavku, výsledek ze odpovědi', async () => {
  let pozadavek;
  const fetchFn = async (url, o) => { pozadavek = { url, ...o }; return { text: async () => '<response><status>ok</status><result><id>1234567890</id><barcode>Z1234567890</barcode><barcodeText>Z 123 4567 890</barcodeText></result></response>' }; };
  const v = await api.vytvoritZasilku({ ...OBJ, obj_jmeno: 'Jan <b>&"Novák' }, 1, { env: ENV, fetchFn });
  assert.deepEqual(v, { packetId: '1234567890', barcode: 'Z1234567890', barcodeText: 'Z 123 4567 890' });
  assert.equal(pozadavek.url, 'https://www.zasilkovna.cz/api/rest');
  assert.equal(pozadavek.method, 'POST');
  assert.match(pozadavek.body, /^<createPacket><apiPassword>a{16}b{16}<\/apiPassword><packetAttributes>/);
  assert.match(pozadavek.body, /<name>Jan<\/name><surname>&lt;b&gt;&amp;&quot;Novák<\/surname>/);
  assert.match(pozadavek.body, /<addressId>12345<\/addressId><cod>0<\/cod><value>1069<\/value><weight>1<\/weight><\/packetAttributes>/);
  assert.doesNotMatch(pozadavek.body, /<eshop>/);
});

test('chyba Zásilkovny: srozumitelná hláška bez hesla', async () => {
  const fault = '<response><status>fault</status><fault>PacketAttributesFault</fault><string>Invalid packet attributes.</string><detail><attributes><fault><name>addressId</name><fault>Unknown pickup point.</fault></fault></attributes></detail></response>';
  await assert.rejects(api.vytvoritZasilku(OBJ, 1, { env: ENV, fetchFn: odpoved(fault) }), e => {
    assert.equal(e.message, 'Invalid packet attributes. (addressId: Unknown pickup point.)');
    assert.ok(!e.message.includes(HESLO));
    return true;
  });
  await assert.rejects(api.vytvoritZasilku(OBJ, 1, { env: ENV, fetchFn: async () => { throw new Error('ECONNRESET ' + HESLO); } }), e => !e.message.includes(HESLO) && /neodpovídá/.test(e.message));
  await assert.rejects(api.vytvoritZasilku(OBJ, 1, { env: ENV, fetchFn: odpoved('<html>502</html>') }), /Neočekávaná odpověď/);
  await assert.rejects(api.vytvoritZasilku(OBJ, 1, { env: {}, fetchFn: odpoved('') }), /není zapnuté/);
});

test('štítek PDF: base64 z odpovědi, jen platný formát a číslo zásilky', async () => {
  let telo;
  const pdf = Buffer.from('%PDF-1.4 test');
  const s = await api.stitekPdf('1234567890', 'A6 on A4', { env: ENV, fetchFn: async (u, o) => { telo = o.body; return { text: async () => `<response><status>ok</status><result>${pdf.toString('base64')}</result></response>` }; } });
  assert.equal(s.toString(), '%PDF-1.4 test');
  assert.match(telo, /<packetLabelPdf><apiPassword>a{16}b{16}<\/apiPassword><packetId>1234567890<\/packetId><format>A6 on A4<\/format><offset>0<\/offset><\/packetLabelPdf>/);
  await assert.rejects(api.stitekPdf('12x', 'A6 on A4', { env: ENV, fetchFn: odpoved('') }), /Neplatné číslo/);
  await assert.rejects(api.stitekPdf('1', 'A0', { env: ENV, fetchFn: odpoved('') }), /formát/);
  await assert.rejects(api.stitekPdf('1', 'A6 on A4', { env: ENV, fetchFn: odpoved('<response><status>ok</status><result>bm90IHBkZg==</result></response>') }), /nevrátila PDF/);
});

test('sledování zásilky: odkaz na tracking Zásilkovny', () => {
  assert.equal(api.sledovaniUrl('Z1234567890'), 'https://tracking.packeta.com/cs/?id=Z1234567890');
});
