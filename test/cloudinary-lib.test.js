// lib/cloudinary.js - ziskatOptimalizovanouUrl musí transformaci aplikovat
// JEN na skutečné Cloudinary delivery URL (podle hostname), nikdy na legacy
// externí URL uložené v produkty.emoji, a nesmí přitom rozbít query string.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ziskatOptimalizovanouUrl } = require('../lib/cloudinary');

test('Cloudinary delivery URL dostane transformaci f_auto,q_auto,w_<šířka>,c_limit hned po /upload/', () => {
  const vysledek = ziskatOptimalizovanouUrl('https://res.cloudinary.com/demo/image/upload/v123/detskekrucky/products/5/foto.jpg', 700);
  assert.equal(vysledek, 'https://res.cloudinary.com/demo/image/upload/f_auto,q_auto,w_700,c_limit/v123/detskekrucky/products/5/foto.jpg');
});

test('legacy externí URL (ne Cloudinary) se vrátí BEZE ZMĚNY', () => {
  const legacy = 'https://i.imgur.com/xyz.jpg';
  assert.equal(ziskatOptimalizovanouUrl(legacy), legacy);
});

test('legacy URL obsahující náhodou podřetězec "/upload/" (např. v query stringu) se NEPŘEVEDE - hostname není Cloudinary', () => {
  const legacy = 'https://example.com/foto.jpg?ref=/upload/neco';
  assert.equal(ziskatOptimalizovanouUrl(legacy), legacy);
});

test('u Cloudinary URL se zachová query string i za cenu vložené transformace do path', () => {
  const vysledek = ziskatOptimalizovanouUrl('https://res.cloudinary.com/demo/image/upload/v1/x.jpg?cache=1', 700);
  assert.equal(vysledek, 'https://res.cloudinary.com/demo/image/upload/f_auto,q_auto,w_700,c_limit/v1/x.jpg?cache=1');
});

test('neplatná/nesestrojitelná URL (nebo null) nikdy nevyhodí výjimku - vrátí se beze změny', () => {
  assert.equal(ziskatOptimalizovanouUrl(null), null);
  assert.equal(ziskatOptimalizovanouUrl(undefined), undefined);
  assert.equal(ziskatOptimalizovanouUrl(''), '');
  assert.equal(ziskatOptimalizovanouUrl('toto neni url'), 'toto neni url');
});
