const postgres = require("postgres");
const { config } = require("./config");

// postgres.js — tagged templates parametrizados (sem concatenação de SQL).
// COUNT/SUM chegam como string (bigint/numeric); convertemos nos SELECTs com ::int / ::float.
const sql = postgres(config.databaseUrl, {
    max: Number(process.env.DB_POOL_MAX) || 10,
    idle_timeout: 30,
    onnotice: () => {},
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

module.exports = sql;
