CREATE TABLE IF NOT EXISTS produkty (
  id SERIAL PRIMARY KEY,
  nazev VARCHAR(255) NOT NULL,
  znacka VARCHAR(255),
  emoji VARCHAR(10),
  popis TEXT,
  kategorie VARCHAR(50),
  cena INTEGER NOT NULL,
  cena_puvodni INTEGER
);

CREATE TABLE IF NOT EXISTS sklad (
  id SERIAL PRIMARY KEY,
  produkt_id INTEGER REFERENCES produkty(id),
  velikost INTEGER NOT NULL,
  pocet_kusu INTEGER NOT NULL DEFAULT 0,
  min_pocet INTEGER NOT NULL DEFAULT 3,
  ean TEXT,
  UNIQUE(produkt_id, velikost)
);

CREATE TABLE IF NOT EXISTS pohyby_skladu (
  id SERIAL PRIMARY KEY,
  produkt_id INTEGER REFERENCES produkty(id),
  velikost INTEGER NOT NULL,
  typ VARCHAR(20) NOT NULL,
  pocet INTEGER NOT NULL,
  poznamka TEXT,
  vytvoreno TIMESTAMP DEFAULT NOW()
);