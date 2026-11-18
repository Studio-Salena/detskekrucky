// Konfigurace EET 2.0 (krok 3). Jen prostředí Playground; PRODUKCE JE V TÉTO VERZI VYPNUTÁ.
//
//   EET_PROSTREDI   prázdné = EET vypnuté (žádné události, nic se neodesílá)
//                   'playground' = oficiální neprodukční prostředí (POK neplatí jako evidence)
//                   'produkce'   = odmítnuto (produkční odesílání není povolené)
//   EET_CERT_PEM    cesta k certifikátu poplatníka (PEM) – soubor jen na serveru, mimo git
//   EET_KLIC_PEM    cesta k privátnímu klíči (PEM, nešifrovaný nebo s EET_KLIC_HESLO)
//   EET_EIC         EIČ poplatníka (musí se shodovat s CN certifikátu)
//   EET_ID_PROVOZ   označení evidenční jednotky (číslo z DIS+, poslední číslice 1–4)
//   EET_ID_POKL     označení pokladního zařízení (1–20 znaků)
//   EET_TIMEOUT_MS  mezní doba odezvy (výchozí 5000; spec. požaduje alespoň 2 s)
// Certifikát ani klíč se nikdy nelogují ani neukládají do databáze.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { RE } = require('./eetZprava');

const PROSTREDI = {
  playground: {
    url: 'https://pg.trzbyeet.gov.cz/eet/services/EETServiceSOAP/v4',
    testovaci: true,
    // podpis potvrzení FS (provozní informace Playgroundu v1.2, kap. 3.3)
    podpisCn: 'NEOSTRE - playground prostredi EET',
    // vydavatel pokladních certifikátů Playgroundu
    vydavatelCertu: /playground EETv2 NCA SubCA/
  }
};

// Důvěryhodné CA pro podpis odpovědí FS (I.CA; otisk kořene ověřen proti www.ica.cz)
function nacistDuveryhodneCa() {
  const slozka = path.join(__dirname, 'eet-ca');
  return fs.readdirSync(slozka).filter(f => f.endsWith('.pem')).map(f => new crypto.X509Certificate(fs.readFileSync(path.join(slozka, f))));
}

class ChybaKonfigurace extends Error {}

// Vrátí konfiguraci, null (EET vypnuté) nebo vyhodí ChybaKonfigurace
function nacist(env = process.env) {
  const prostredi = String(env.EET_PROSTREDI || '').trim().toLowerCase();
  if (!prostredi) return null;
  if (prostredi === 'produkce') throw new ChybaKonfigurace('Produkční odesílání EET není v této verzi povolené (jen Playground).');
  const p = PROSTREDI[prostredi];
  if (!p) throw new ChybaKonfigurace(`Neznámé prostředí EET „${prostredi}“.`);
  const eic = String(env.EET_EIC || '').trim();
  const idProvoz = String(env.EET_ID_PROVOZ || '').trim();
  const idPokl = String(env.EET_ID_POKL || '').trim();
  if (!RE.eic.test(eic)) throw new ChybaKonfigurace('EET_EIC musí mít tvar CZ + 8–10 číslic.');
  if (!RE.idJednotky.test(idProvoz)) throw new ChybaKonfigurace('EET_ID_PROVOZ musí být číslo evidenční jednotky.');
  if (!RE.string20.test(idPokl)) throw new ChybaKonfigurace('EET_ID_POKL: 1–20 znaků (písmena, číslice, .,:;/#-_ a mezera).');
  let certPem, klicPem, cert, klic;
  try {
    certPem = fs.readFileSync(String(env.EET_CERT_PEM || ''), 'utf8');
    klicPem = fs.readFileSync(String(env.EET_KLIC_PEM || ''), 'utf8');
    cert = new crypto.X509Certificate(certPem);
    klic = crypto.createPrivateKey({ key: klicPem, passphrase: env.EET_KLIC_HESLO || undefined });
  } catch (e) {
    throw new ChybaKonfigurace('Certifikát nebo klíč EET nejde načíst (EET_CERT_PEM, EET_KLIC_PEM).');
  }
  if (!cert.checkPrivateKey(klic)) throw new ChybaKonfigurace('Privátní klíč nepatří k certifikátu EET.');
  const cn = (cert.subject.split('\n').find(s => s.startsWith('CN=')) || '').slice(3);
  if (cn !== eic) throw new ChybaKonfigurace(`EIČ v certifikátu (${cn}) se neshoduje s EET_EIC (${eic}).`);
  if (!p.vydavatelCertu.test(cert.issuer)) throw new ChybaKonfigurace('Certifikát nepatří prostředí ' + prostredi + ' (jiný vydavatel).');
  if (new Date(cert.validTo) < new Date()) throw new ChybaKonfigurace('Certifikát EET už není platný.');
  const timeout = Math.max(2000, Number(env.EET_TIMEOUT_MS) || 5000);
  return {
    prostredi, testovaci: p.testovaci, url: p.url, podpisCn: p.podpisCn, eic, idProvoz, idPokl, timeout,
    certPem, klicPem: klic.export({ type: 'pkcs8', format: 'pem' }),
    certPlatnyDo: cert.validTo, duveryhodneCa: nacistDuveryhodneCa()
  };
}

// Bezpečný popis pro admin a logy (bez klíče a certifikátu)
function popis(k) {
  if (!k) return { zapnuto: false };
  return { zapnuto: true, prostredi: k.prostredi, testovaci: k.testovaci, url: k.url, eic: k.eic, id_provoz: k.idProvoz, id_pokl: k.idPokl,
    cert_platny_do: k.certPlatnyDo, timeout_ms: k.timeout };
}

module.exports = { nacist, popis, ChybaKonfigurace, PROSTREDI, nacistDuveryhodneCa };
