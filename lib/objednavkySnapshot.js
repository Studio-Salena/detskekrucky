// Snímek (snapshot) osobních údajů v objednávce.
//
// zakaznici = aktuální údaje zákazníka/profilu,
// objednavky.obj_* = údaje zadané při TÉTO objednávce (nemění se).
//
// Dřív objednávka údaje neměla a admin/faktura/e-maily četly aktuální
// zakaznici - kdo znal cizí e-mail, mohl objednávkou bez účtu přepsat
// zákazníkovi adresu a tím i adresu jeho dosud neodeslaných objednávek.

const SQL_SLOUPCE = `
  ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS obj_jmeno TEXT;
  ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS obj_email TEXT;
  ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS obj_telefon TEXT;
  ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS obj_ulice TEXT;
  ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS obj_mesto TEXT;
  ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS obj_psc TEXT;
  ALTER TABLE objednavky ADD COLUMN IF NOT EXISTS udaje_doplneny_zpetne BOOLEAN NOT NULL DEFAULT false;
`;

// Objednávkám bez snímku (vzniklým před zavedením snímku) se zmrazí údaje
// zákazníka platné V OKAMŽIKU MIGRACE - nejde o obnovu historických údajů
// (ty v DB nikdy uložené nebyly), proto příznak udaje_doplneny_zpetne.
// Bere jen objednávky, které nemají vyplněné ŽÁDNÉ pole snímku - existující
// snímek se nikdy nepřepíše a opakované spuštění nic nezmění.
const SQL_DOPLNIT = `
  UPDATE objednavky o SET
    obj_jmeno = z.jmeno, obj_email = z.email, obj_telefon = z.telefon,
    obj_ulice = z.ulice, obj_mesto = z.mesto, obj_psc = z.psc,
    udaje_doplneny_zpetne = true
  FROM zakaznici z
  WHERE o.zakaznik_id = z.id
    AND o.obj_jmeno IS NULL AND o.obj_email IS NULL AND o.obj_telefon IS NULL
    AND o.obj_ulice IS NULL AND o.obj_mesto IS NULL AND o.obj_psc IS NULL
`;

const SQL_BEZ_SNIMKU = `SELECT id, cislo, zakaznik_id FROM objednavky WHERE obj_email IS NULL ORDER BY id`;

// Sloupce + doplnění jako jeden dotaz o více příkazech - PostgreSQL ho
// provede v jedné implicitní transakci (buď vše, nebo nic). Spouští se při
// každém startu serveru; díky podmínkám výše je to bezpečné a doplní i
// objednávky, které by mezitím bez snímku vytvořila starší běžící verze.
async function migrovatSnapshoty(db) {
  await db.query(SQL_SLOUPCE + ';' + SQL_DOPLNIT);
  const bezSnimku = await db.query(SQL_BEZ_SNIMKU);
  return bezSnimku.rows;
}

// Údaje objednávky pro čtení. O zdroji se rozhoduje JEDNOU za celou objednávku
// (snímek existuje = obj_email IS NOT NULL), ne po polích - jinak by u snímku
// doplněného migrací s prázdným polem (NULL) šlo to pole dotáhnout z aktuálního
// zákazníka a objednávka by byla poskládaná ze dvou zdrojů. Prázdné pole
// snímku tedy zůstane prázdné. Bez snímku (přechodně) celý aktuální zákazník.
// Aliasy mají stejné názvy jako dřív, ať se nemusí měnit admin.
const MA_SNIMEK = 'o.obj_email IS NOT NULL';
const udaj = (pole) => `CASE WHEN ${MA_SNIMEK} THEN o.obj_${pole} ELSE z.${pole} END AS ${pole}`;
const SQL_UDAJE_OBJEDNAVKY = ['jmeno', 'email', 'telefon', 'ulice', 'mesto', 'psc'].map(udaj).join(',\n  ');

module.exports = { migrovatSnapshoty, SQL_SLOUPCE, SQL_DOPLNIT, SQL_BEZ_SNIMKU, SQL_UDAJE_OBJEDNAVKY };
