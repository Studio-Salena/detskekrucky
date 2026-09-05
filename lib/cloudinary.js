// Tenký wrapper nad Cloudinary SDK. Konfiguruje se z proměnných prostředí
// CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET, které
// jsou jen na backendu (Render) - nikdy se neposílají frontendu ani necommitují.
//
// DŮLEŽITÉ: pokud tyhle proměnné nejsou nastavené, appka nesmí spadnout při
// startu - cloudinary.config() s undefined hodnotami nevyhazuje výjimku, jen
// skutečné volání API pak selže. jeNakonfigurovano() to dovoluje zjistit
// předem, ať endpoint může vrátit srozumitelnou konfigurační chybu.
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

function jeNakonfigurovano() {
  return !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

// Nahraje buffer do Cloudinary do dané složky. Vrací jen to, co si DB
// skutečně ukládá (secure_url -> url, public_id -> storage_key).
function nahratObrazek(buffer, { folder }) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (err, result) => {
        if (err) return reject(err);
        resolve({ secure_url: result.secure_url, public_id: result.public_id });
      }
    );
    stream.end(buffer);
  });
}

// Best-effort smazání - nikdy nevyhazuje, jen vrátí { ok: false } a volající
// si storage_key zaloguje pro případný ruční úklid.
async function smazatObrazek(publicId) {
  if (!publicId) return { ok: true };
  try {
    await cloudinary.uploader.destroy(publicId);
    return { ok: true };
  } catch (e) {
    return { ok: false, chyba: e.message };
  }
}

// DB drží jen originální secure_url - žádné fyzické thumbnaily se
// negenerují ani neukládají. Pro grid/náhled se transformace (formát,
// kvalita, resize) vloží přímo do URL až při odpovědi klientovi. Funguje
// jen na skutečných Cloudinary delivery URL (obsahují "/upload/") - legacy
// externí URL (starý produkty.emoji) se vrátí beze změny.
function ziskatOptimalizovanouUrl(url, sirkaPx = 700) {
  if (!url || typeof url !== 'string') return url;
  const marker = '/upload/';
  const idx = url.indexOf(marker);
  if (idx === -1) return url;
  const pred = url.slice(0, idx + marker.length);
  const za = url.slice(idx + marker.length);
  return `${pred}f_auto,q_auto,w_${sirkaPx},c_limit/${za}`;
}

module.exports = { jeNakonfigurovano, nahratObrazek, smazatObrazek, ziskatOptimalizovanouUrl };
