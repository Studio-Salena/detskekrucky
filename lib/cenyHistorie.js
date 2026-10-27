// Historie cen kvůli slevám (zákon o ochraně spotřebitele § 12a): při oznámení
// slevy musí být jako předchozí cena uvedena nejnižší cena za 30 dní před slevou.
//
// - ceny_historie: každá změna produkty.cena. Zapisuje ji trigger v DB, takže
//   se zachytí změna odkudkoli (sklad, sleva, budoucí úpravy) a nedá se obejít.
// - nejnizsi_cena_30_dni(id): cena platná před 30 dny + všechny ceny od té doby.
// - produkty.cena_pred_slevou: běžná cena během slevy (z ní se sleva počítá
//   a po zrušení slevy se vrátí). produkty.cena_puvodni je jen přeškrtnutá
//   cena pro e-shop = nejnižší cena za 30 dní, nastavuje ji výhradně sleva.
//
// Historie začíná nasazením: produkt bez záznamu dostane záznam s dnešní cenou.

async function migrovatCenyHistorie(db) {
  // Jeden dotaz = jedna transakce (trigger se nevymění napůl)
  await db.query(`
    ALTER TABLE produkty ADD COLUMN IF NOT EXISTS cena_pred_slevou INTEGER;
    CREATE TABLE IF NOT EXISTS ceny_historie (
      id SERIAL PRIMARY KEY,
      produkt_id INTEGER NOT NULL REFERENCES produkty(id) ON DELETE CASCADE,
      cena INTEGER NOT NULL,
      od TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ceny_historie_produkt_od_idx ON ceny_historie (produkt_id, od);
    CREATE OR REPLACE FUNCTION zapsat_cenu_produktu() RETURNS trigger AS $$
    BEGIN
      IF NEW.cena IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.cena IS DISTINCT FROM OLD.cena) THEN
        INSERT INTO ceny_historie (produkt_id, cena) VALUES (NEW.id, NEW.cena);
      END IF;
      RETURN NEW;
    END
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS produkty_cena_historie ON produkty;
    CREATE TRIGGER produkty_cena_historie AFTER INSERT OR UPDATE OF cena ON produkty
      FOR EACH ROW EXECUTE FUNCTION zapsat_cenu_produktu();
    CREATE OR REPLACE FUNCTION nejnizsi_cena_30_dni(pid INTEGER) RETURNS INTEGER AS $$
      SELECT MIN(cena) FROM (
        (SELECT cena FROM ceny_historie WHERE produkt_id = pid AND od <= NOW() - INTERVAL '30 days' ORDER BY od DESC, id DESC LIMIT 1)
        UNION ALL
        (SELECT cena FROM ceny_historie WHERE produkt_id = pid AND od > NOW() - INTERVAL '30 days')
      ) x
    $$ LANGUAGE sql STABLE;
    INSERT INTO ceny_historie (produkt_id, cena)
      SELECT p.id, p.cena FROM produkty p
      WHERE p.cena IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ceny_historie h WHERE h.produkt_id = p.id);
    UPDATE produkty SET cena_pred_slevou = cena_puvodni WHERE cena_puvodni IS NOT NULL AND cena_pred_slevou IS NULL;
  `);
}

module.exports = { migrovatCenyHistorie };
