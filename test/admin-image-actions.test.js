// Regresní test: admin.html image akce (nastavitHlavniFotku, smazatFotku,
// upravitAltFotky, posunoutFotku) musí kontrolovat response.ok - fetch() na
// HTTP 4xx/5xx nevyhazuje výjimku, takže bez explicitní kontroly by se chyba
// serveru tiše považovala za úspěch. Stejný vzor jako ostatní XSS/admin testy:
// vytáhne skutečný zdrojový kód funkcí z admin.html a spustí ho ve vm
// sandboxu s mockovaným adminFetch/alert/confirm - netestuje vlastní kopii.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ADMIN_HTML = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

function vytahnoutFunkci(nazev) {
  const marker = `function ${nazev}(`;
  let start = ADMIN_HTML.indexOf(marker);
  assert.ok(start !== -1, `Funkce ${nazev} nebyla v admin.html nalezena`);
  if (ADMIN_HTML.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const zavorkaStart = ADMIN_HTML.indexOf('{', start);
  let hloubka = 0;
  let konec = -1;
  for (let i = zavorkaStart; i < ADMIN_HTML.length; i++) {
    if (ADMIN_HTML[i] === '{') hloubka++;
    else if (ADMIN_HTML[i] === '}') {
      hloubka--;
      if (hloubka === 0) { konec = i + 1; break; }
    }
  }
  assert.ok(konec !== -1, `Nepodařilo se najít konec funkce ${nazev}`);
  return ADMIN_HTML.slice(start, konec);
}

// Vytvoří novou izolovanou vm sandbox s mockovaným prostředím admin.html
// (adminFetch, alert, confirm, nacistFotkyProduktu, fotkyData/fotkyProduktId)
// a nadefinuje v ní danou funkci vytaženou přímo ze zdroje.
function pripravitSandbox(nazevFunkce, { fetchOdpovedi, confirmVraci = true } = {}) {
  const volaniAlert = [];
  let pocetVolaniFetch = 0;
  let pocetNacteni = 0;

  const sandbox = {
    fotkyProduktId: 42,
    fotkyData: [{ id: 1, position: 0, is_primary: true }, { id: 2, position: 1, is_primary: false }],
    API: 'https://api.example.test',
    alert(zprava) { volaniAlert.push(zprava); },
    confirm() { return confirmVraci; },
    async adminFetch(url, options) {
      const odpoved = fetchOdpovedi[pocetVolaniFetch] !== undefined ? fetchOdpovedi[pocetVolaniFetch] : fetchOdpovedi[fetchOdpovedi.length - 1];
      pocetVolaniFetch++;
      return odpoved;
    },
    async nacistFotkyProduktu() { pocetNacteni++; }
  };
  vm.createContext(sandbox);
  vm.runInContext(vytahnoutFunkci(nazevFunkce), sandbox);

  return {
    sandbox,
    volaniAlert,
    pocetVolaniFetch: () => pocetVolaniFetch,
    pocetNacteni: () => pocetNacteni,
    async spustit(...argy) {
      sandbox.__argy = argy;
      return vm.runInContext(`${nazevFunkce}(...__argy)`, sandbox);
    }
  };
}

test('nastavitHlavniFotku: HTTP chyba (ok:false) se NEPOVAŽUJE za úspěch - zobrazí alert, galerie se znovu nenačte', async () => {
  const t = pripravitSandbox('nastavitHlavniFotku', { fetchOdpovedi: [{ ok: false, status: 409 }] });
  await t.spustit(2);
  assert.equal(t.volaniAlert.length, 1);
  assert.equal(t.pocetNacteni(), 0);
});

test('nastavitHlavniFotku: úspěšná odpověď (ok:true) žádný alert nezobrazí a galerii znovu načte', async () => {
  const t = pripravitSandbox('nastavitHlavniFotku', { fetchOdpovedi: [{ ok: true, status: 200 }] });
  await t.spustit(2);
  assert.equal(t.volaniAlert.length, 0);
  assert.equal(t.pocetNacteni(), 1);
});

test('smazatFotku: HTTP chyba (ok:false) se NEPOVAŽUJE za úspěch - zobrazí alert, galerie se znovu nenačte', async () => {
  const t = pripravitSandbox('smazatFotku', { fetchOdpovedi: [{ ok: false, status: 500 }] });
  await t.spustit(1);
  assert.equal(t.volaniAlert.length, 1);
  assert.equal(t.pocetNacteni(), 0);
});

test('upravitAltFotky: HTTP chyba (ok:false) se NEPOVAŽUJE za úspěch - zobrazí alert', async () => {
  const t = pripravitSandbox('upravitAltFotky', { fetchOdpovedi: [{ ok: false, status: 400 }] });
  await t.spustit(1, 'nový alt text');
  assert.equal(t.volaniAlert.length, 1);
});

test('upravitAltFotky: úspěšná odpověď nezobrazí alert', async () => {
  const t = pripravitSandbox('upravitAltFotky', { fetchOdpovedi: [{ ok: true, status: 200 }] });
  await t.spustit(1, 'nový alt text');
  assert.equal(t.volaniAlert.length, 0);
});

test('posunoutFotku: pokud JEDNA ze dvou paralelních PATCH odpovědí není ok, zobrazí se alert (Promise.all nesmí ok kontrolu obejít)', async () => {
  // Dvě paralelní volání (a.id, b.id) - první ok, druhé selže.
  const t = pripravitSandbox('posunoutFotku', { fetchOdpovedi: [{ ok: true, status: 200 }, { ok: false, status: 500 }] });
  await t.spustit(1, 1); // posunout fotku id=1 o 1 pozici dolů (id=2 existuje na pozici 1)
  assert.equal(t.volaniAlert.length, 1);
});

test('posunoutFotku: obě paralelní PATCH odpovědi ok -> žádný alert, galerie se znovu načte', async () => {
  const t = pripravitSandbox('posunoutFotku', { fetchOdpovedi: [{ ok: true, status: 200 }, { ok: true, status: 200 }] });
  await t.spustit(1, 1);
  assert.equal(t.volaniAlert.length, 0);
  assert.equal(t.pocetNacteni(), 1);
});
