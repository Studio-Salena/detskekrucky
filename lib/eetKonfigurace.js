// Konfigurace EET 2.0. Prostředí jsou ODDĚLENÁ: adresa služby, vydavatel pokladních
// certifikátů, podepisující potvrzení FS, důvěryhodné CA (lib/eet-ca/<prostredi>/),
// minimální datum tržby i fronta (události nesou prostředí a identitu pokladny a jiná
// konfigurace je nikdy neodešle). Podklady: docs/eet-krok3.md (provozní informace
// Playground v1.2 a Produkce v1.2, obě 11. 11. 2026).
//
//   EET_PROSTREDI   prázdné = EET vypnuté (žádné události, nic se neodesílá) – VÝCHOZÍ
//                   'playground' = oficiální neprodukční prostředí (POK neplatí jako evidence)
//                   'produkce'   = produkční evidence; zapne se JEN když navíc platí vše níže:
//     EET_PRODUKCE_POVOLENA = 'ano'  (výslovné potvrzení, jiná hodnota = odmítnuto)
//     EET_PRODUKCE_OD       = počátek produkční evidence, ISO s časovou zónou
//                             (např. 2027-01-01T00:00:00+01:00); tržby před ním se neevidují,
//                             nic se zpětně nedoplňuje; po prvním spuštění je v DB pevný
//     certifikát vydaný produkční CA EET („EETv2 NCA SubCA RSA …“, ne playground)
//   EET_CERT_PEM    cesta k certifikátu poplatníka (PEM) – soubor jen na serveru, mimo git
//   EET_KLIC_PEM    cesta k privátnímu klíči (PEM, nešifrovaný nebo s EET_KLIC_HESLO)
//   EET_EIC         EIČ poplatníka (musí se shodovat s CN certifikátu)
//   EET_ID_PROVOZ   označení evidenční jednotky (číslo z DIS+)
//   EET_ID_POKL     označení pokladního zařízení (1–20 znaků)
//   EET_TIMEOUT_MS  mezní doba odezvy (výchozí 5000; podle podkladů alespoň 2 s)
// Jakákoli chyba nastavení = EET zůstane vypnuté a admin/dohled hlásí důvod.
// Certifikát ani klíč se nikdy nelogují ani neukládají do databáze.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { RE } = require('./eetZprava');

const PROSTREDI = Object.freeze({
  playground: Object.freeze({
    url: 'https://pg.trzbyeet.gov.cz/eet/services/EETServiceSOAP/v4',
    testovaci: true,
    // podpis potvrzení FS (provozní informace Playground v1.2, kap. 3.3)
    podpisCn: 'NEOSTRE - playground prostredi EET',
    // vydavatel pokladních certifikátů (kap. 3.1.3)
    vydavatelCertu: /(^|\n|, )CN=playground EETv2 NCA SubCA RSA /,
    slozkaCa: 'playground',
    minDatTrzby: '2026-07-01T00:00:00+02:00' // kap. 4.1
  }),
  produkce: Object.freeze({
    url: 'https://trzbyeet.gov.cz/eet/services/EETServiceSOAP/v4', // provozní informace Produkce v1.2, kap. 2.1
    testovaci: false,
    podpisCn: 'Spolecne technicke zarizeni spravce dane EET', // kap. 3.3
    vydavatelCertu: /(^|\n|, )CN=EETv2 NCA SubCA RSA /,         // kap. 3.1.1 (bez „playground“)
    slozkaCa: 'produkce',
    minDatTrzby: '2026-11-01T00:00:00+01:00' // kap. 4.1: přechodný režim od 1. 11. 2026, běžně od 1. 1. 2027
  })
});

// Důvěryhodné CA pro podpis odpovědí FS – každé prostředí má vlastní složku
function nacistDuveryhodneCa(prostredi = 'playground') {
  const p = PROSTREDI[prostredi];
  if (!p) throw new Error('Neznámé prostředí ' + prostredi);
  const slozka = path.join(__dirname, 'eet-ca', p.slozkaCa);
  return fs.readdirSync(slozka).filter(f => f.endsWith('.pem')).map(f => new crypto.X509Certificate(fs.readFileSync(path.join(slozka, f))));
}

class ChybaKonfigurace extends Error {}

const ISO_S_ZONOU = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?(Z|[+-]\d\d:\d\d)$/;

// Vrátí konfiguraci, null (EET vypnuté) nebo vyhodí ChybaKonfigurace
function nacist(env = process.env, ted = new Date()) {
  const prostredi = String(env.EET_PROSTREDI || '').trim().toLowerCase();
  if (!prostredi) return null;
  const p = Object.prototype.hasOwnProperty.call(PROSTREDI, prostredi) ? PROSTREDI[prostredi] : null;
  if (!p) throw new ChybaKonfigurace(`Neznámé prostředí EET „${prostredi}“ (povolené: playground, produkce).`);
  let produkceOd = null;
  if (prostredi === 'produkce') {
    if (String(env.EET_PRODUKCE_POVOLENA || '') !== 'ano') {
      throw new ChybaKonfigurace('Produkční evidence není povolená: chybí výslovné EET_PRODUKCE_POVOLENA=ano.');
    }
    const od = String(env.EET_PRODUKCE_OD || '').trim();
    if (!ISO_S_ZONOU.test(od) || Number.isNaN(new Date(od).getTime())) {
      throw new ChybaKonfigurace('EET_PRODUKCE_OD musí být počátek produkční evidence s časovou zónou, např. 2027-01-01T00:00:00+01:00.');
    }
    produkceOd = new Date(od);
    if (produkceOd < new Date(p.minDatTrzby)) throw new ChybaKonfigurace(`EET_PRODUKCE_OD je před minimálním datem tržby produkčního prostředí (${p.minDatTrzby}).`);
  } else if (env.EET_PRODUKCE_POVOLENA || env.EET_PRODUKCE_OD) {
    // produkční přepínače u testovacího prostředí = zmatené nastavení, raději nic
    throw new ChybaKonfigurace('EET_PRODUKCE_POVOLENA / EET_PRODUKCE_OD patří jen k EET_PROSTREDI=produkce.');
  }
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
  // testovací certifikát nikdy do produkce a naopak (vydavatel playgroundu obsahuje „EETv2 NCA SubCA“ také)
  if (prostredi === 'produkce' && /playground/i.test(cert.issuer)) throw new ChybaKonfigurace('Certifikát Playgroundu nejde použít v produkci.');
  if (new Date(cert.validTo) < ted) throw new ChybaKonfigurace('Certifikát EET už není platný.');
  if (new Date(cert.validFrom) > ted) throw new ChybaKonfigurace('Certifikát EET ještě není platný.');
  const timeout = Math.max(2000, Number(env.EET_TIMEOUT_MS) || 5000);
  return Object.freeze({
    prostredi, testovaci: p.testovaci, url: p.url, podpisCn: p.podpisCn, eic, idProvoz, idPokl, timeout,
    produkceOd, minDatTrzby: new Date(p.minDatTrzby),
    // čistý PEM jen s certifikátem (openssl pkcs12 přidává „Bag Attributes“, které by se
    // jinak dostaly do BinarySecurityToken a FS by odmítl podpis kódem 4)
    certPem: cert.toString(), klicPem: klic.export({ type: 'pkcs8', format: 'pem' }),
    certPlatnyDo: cert.validTo, certOtisk: cert.fingerprint256, duveryhodneCa: nacistDuveryhodneCa(prostredi)
  });
}

// Bezpečný popis pro admin a logy (bez klíče a certifikátu)
function popis(k) {
  if (!k) return { zapnuto: false };
  return { zapnuto: true, prostredi: k.prostredi, testovaci: k.testovaci, url: k.url, eic: k.eic, id_provoz: k.idProvoz, id_pokl: k.idPokl,
    cert_platny_do: k.certPlatnyDo, timeout_ms: k.timeout, produkce_od: k.produkceOd ? k.produkceOd.toISOString() : null };
}

module.exports = { nacist, popis, ChybaKonfigurace, PROSTREDI, nacistDuveryhodneCa };
