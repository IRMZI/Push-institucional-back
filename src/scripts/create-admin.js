// Cria (ou redefine a senha de) um usuário do painel.
// Uso: npm run create-admin -- <usuario> <senha> [nome] [admin|membro]
const { assertRequiredEnv } = require("../config");
assertRequiredEnv();
const sql = require("../db");
const { migrate } = require("../migrate");
const { hashPassword } = require("../lib/users");

async function main() {
    const [username, password, nome = null, role = "admin"] = process.argv.slice(2);
    if (!username || !password) {
        console.error("Uso: npm run create-admin -- <usuario> <senha> [nome] [admin|membro]");
        process.exit(1);
    }
    if (password.length < 10) {
        console.error("A senha precisa ter ao menos 10 caracteres.");
        process.exit(1);
    }
    if (!["admin", "membro"].includes(role)) {
        console.error("role deve ser 'admin' ou 'membro'.");
        process.exit(1);
    }
    await migrate(sql);
    const hash = await hashPassword(password);
    const rows = await sql`
      INSERT INTO admin_users (username, nome, senha_hash, role)
      VALUES (${username.toLowerCase()}, ${nome}, ${hash}, ${role})
      ON CONFLICT (LOWER(username)) DO UPDATE SET senha_hash = EXCLUDED.senha_hash, role = EXCLUDED.role, ativo = true,
        nome = COALESCE(EXCLUDED.nome, admin_users.nome)
      RETURNING id, username, role`;
    console.log(`Usuário '${rows[0].username}' (${rows[0].role}) pronto. id=${rows[0].id}`);
    await sql.end();
}

main().catch(async (err) => {
    console.error(err);
    await sql.end({ timeout: 1 });
    process.exit(1);
});
