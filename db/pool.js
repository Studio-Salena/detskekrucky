const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('CHYBA: DATABASE_URL není nastavena v proměnných prostředí!');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

module.exports = pool;