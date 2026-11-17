// Obrazovky evidence plateb v adminu (bez DB a prohlížeče - jen kontrola kódu stránky;
// skutečné chování ověřuje prohlížečový test na lokálním serveru, viz docs).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8').replace(/\r\n/g, '\n');
const funkce = jmeno => {
  const i = html.indexOf(`function ${jmeno}(`);
  assert.ok(i > 0, 'chybí funkce ' + jmeno);
  return html.slice(i, html.indexOf('\n}\n', i));
};

test('Účetnictví má záložku Platby a dobírky s volnými platbami a vyúčtováním dobírek', () => {
  assert.match(html, /data-cil="platby" onclick="prepnoutPohled\('ucetnictvi','platby'\);nacistPlatbyADobirky\(\)"/);
  assert.match(html, /<div data-pohled="platby">/);
  for (const id of ['vpZpusob', 'vpCastka', 'volnePlatbyTab', 'dobirkyTab', 'dvPoplatek', 'vyuctovaniTab']) assert.match(html, new RegExp(`id="${id}"`));
});

test('přiřazení i vyúčtování jdou přes odeslatOperaci (klíč proti opakování zůstává při výpadku)', () => {
  assert.match(funkce('priraditPlatbu'), /odeslatOperaci\('prirazeni-' \+ platbaId/);
  assert.match(funkce('zapsatVolnouPlatbu'), /odeslatOperaci\('volna-platba'/);
  assert.match(funkce('vyuctovatDobirky'), /odeslatOperaci\('vyuctovani-dobirek'/);
  assert.match(funkce('zapsatPlatbuPoukazu'), /odeslatOperaci\('poukaz-platba-' \+ id/);
  const o = funkce('odeslatOperaci');
  assert.ok(o.indexOf('hotovaOperace(nazev)') > o.indexOf('await adminFetch'), 'klíč se uvolní až po odpovědi serveru');
});

test('poukaz se hradí jen celou hodnotou; nepokrytý poukaz se v nabídce neukáže', () => {
  assert.match(funkce('vyplnitCastkuPrirazeni'), /pole\.readOnly = sel\.value\.startsWith\('p:'\)/);
  assert.match(funkce('moznostiPrirazeni'), /filter\(x => Number\(x\.hodnota\) <= volno\)/);
});

test('poukaz čekající na platbu: stav v seznamu, v detailu zápis platby; „zaplatí později“ místo „neevidovat“', () => {
  assert.match(html, /ceka_na_platbu:'<span class="badge badge-nova">⏳ Čeká na platbu<\/span>'/);
  assert.match(html, /poukaz\.stav === 'ceka_na_platbu' \? `<div class="info-box">⏳ <strong>Poukaz čeká na platbu/);
  assert.doesNotMatch(html, /Nezaplaceno \/ neevidovat platbu/);
});

test('Kontrola plateb rozlišuje doklady mimo rozsah (nejsou spárované)', () => {
  const k = funkce('kontrolaPlateb');
  assert.match(k, /mimo_rozsah/);
  assert.match(k, /NEJSOU tím spárované/);
});
