// Kontrola nahrávaných obrázků (fotky produktů, obrázky kategorií) - sdílená,
// ať mají všechny uploady stejná pravidla na velikost a skutečný typ souboru.

const MAX_MB = 10;
const MAX_BYTES = MAX_MB * 1024 * 1024;
const POVOLENE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);

// Skutečné HEIC/HEIF major brandy (ISO-BMFF "ftyp" box, 4 ASCII znaky hned
// po něm). Nestačí kontrolovat jen přítomnost "ftyp" - ten box má naprosto
// každý ISO-BMFF soubor (i MP4/MOV video, i audio) - musí sedět konkrétní
// brand, jinak by jako "HEIC obrázek" prošlo libovolné video přejmenované
// na .jpg s podvrženým Content-Type.
const HEIC_BRANDY = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1']);

// Ověří skutečný obsah souboru podle magických bajtů na začátku - nespoléhá
// jen na Content-Type/příponu, kterou klient (i omylem přejmenovaný soubor
// z telefonu) může poslat špatně nebo záměrně zfalšovat.
function zjistitSkutecnyTypObrazku(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png';
  if (buffer.slice(0, 4).toString('ascii') === 'GIF8') return 'gif';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buffer.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.slice(8, 12).toString('ascii');
    return HEIC_BRANDY.has(brand) ? 'heic' : null;
  }
  return null;
}

// Který skutečně detekovaný typ smí přijít s jakým deklarovaným Content-Type
// - nestačí, že MIME je z povolené množiny A buffer vypadá jako "nějaký"
// obrázek; deklarovaný MIME musí sedět na detekovaný typ (mimetype=image/jpeg
// s GIF obsahem se odmítne).
const TYP_NA_POVOLENE_MIME = {
  jpeg: new Set(['image/jpeg']),
  png: new Set(['image/png']),
  gif: new Set(['image/gif']),
  webp: new Set(['image/webp']),
  heic: new Set(['image/heic', 'image/heif'])
};

// Vrací text chyby pro uživatele, nebo null, když je soubor v pořádku.
function overitSoubor(soubor) {
  if (soubor.size > MAX_BYTES) return `Soubor je příliš velký (max ${MAX_MB} MB na fotografii).`;
  if (!POVOLENE_MIME.has(soubor.mimetype)) return 'Nepovolený typ souboru. Nahrajte prosím fotografii (JPEG/PNG/WEBP/HEIC).';
  const skutecnyTyp = zjistitSkutecnyTypObrazku(soubor.buffer);
  if (!skutecnyTyp) return 'Soubor nevypadá jako platný obrázek.';
  if (!TYP_NA_POVOLENE_MIME[skutecnyTyp].has(soubor.mimetype)) return 'Deklarovaný typ souboru neodpovídá jeho skutečnému obsahu.';
  return null;
}

module.exports = { MAX_MB, MAX_BYTES, POVOLENE_MIME, TYP_NA_POVOLENE_MIME, zjistitSkutecnyTypObrazku, overitSoubor };
