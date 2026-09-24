const bcrypt = require("bcryptjs");
const sql = require("../db");
const { config } = require("../config");

const BCRYPT_ROUNDS = 12;
const hashPassword = (plain) => bcrypt.hash(plain, BCRYPT_ROUNDS);

// Garante que o admin definido no ambiente exista (primeiro acesso ao painel).
// Não sobrescreve a senha se o usuário já existir — troque pelo painel ou pelo create-admin.
async function ensureEnvAdmin() {
    const username = config.adminUsername;
    const existing = await sql`SELECT id FROM admin_users WHERE LOWER(username) = LOWER(${username})`;
    if (existing.length > 0) return false;
    const hash = await hashPassword(config.adminPassword);
    await sql`
      INSERT INTO admin_users (username, nome, senha_hash, role)
      VALUES (${username}, ${"Administrador"}, ${hash}, 'admin')
      ON CONFLICT DO NOTHING`;
    console.log(`[auth] Admin inicial '${username}' criado a partir do ambiente.`);
    return true;
}

module.exports = { hashPassword, ensureEnvAdmin, BCRYPT_ROUNDS };
