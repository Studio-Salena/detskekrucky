// Middleware, který chrání citlivé/administrátorské endpointy.
// Vyžaduje hlavičku 'x-admin-heslo' odpovídající tajnému heslu
// uloženému v proměnné prostředí ADMIN_HESLO (nastavuje se na Renderu,
// nikdy není součástí kódu v repozitáři).

const { jeZablokovana, zaznamenatNeuspech, resetovat } = require('./loginLimiter');

module.exports = function vyzadovatAdmina(req, res, next) {
  const heslo = req.headers['x-admin-heslo'];
  const ip = req.ip;

  if (!process.env.ADMIN_HESLO) {
    // Bezpečnostní pojistka: pokud admin heslo není na serveru vůbec nastavené,
    // radši vše zablokujeme, než abychom nechali endpoint otevřený.
    console.error('ADMIN_HESLO není nastaveno v proměnných prostředí!');
    return res.status(500).json({ chyba: 'Server není správně nakonfigurován.' });
  }

  const zbyvaSekund = jeZablokovana(ip);
  if (zbyvaSekund > 0) {
    return res.status(429).json({ chyba: `Příliš mnoho neúspěšných pokusů. Zkuste to znovu za ${Math.ceil(zbyvaSekund / 60)} min.` });
  }

  if (heslo && heslo === process.env.ADMIN_HESLO) {
    resetovat(ip);
    return next();
  }

  zaznamenatNeuspech(ip);
  res.status(403).json({ chyba: 'Neautorizovaný přístup. Přihlaste se prosím znovu do administrace.' });
};
