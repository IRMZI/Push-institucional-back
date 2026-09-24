const { config, assertRequiredEnv } = require("./config");

// Aborta a subida se faltar DATABASE_URL, JWT_SECRET, ADMIN_USERNAME ou ADMIN_PASSWORD
assertRequiredEnv();

const sql = require("./db");
const { migrate } = require("./migrate");
const { ensureEnvAdmin } = require("./lib/users");
const { createApp } = require("./app");

async function start() {
    // Migrations são idempotentes: rodar na subida mantém o schema sempre em dia no deploy.
    if (process.env.RUN_MIGRATIONS_ON_START !== "false") {
        await migrate(sql);
        console.log("[db] Migrations aplicadas.");
    }
    await ensureEnvAdmin();

    const app = createApp();
    const server = app.listen(config.port, "0.0.0.0", () => {
        console.log(`[api] PUSH API rodando na porta ${config.port}`);
    });

    const shutdown = (signal) => {
        console.log(`[api] ${signal} recebido, encerrando...`);
        server.close(() => sql.end({ timeout: 5 }).finally(() => process.exit(0)));
        setTimeout(() => process.exit(1), 10_000).unref();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
    console.error("[api] Falha ao iniciar:", err);
    process.exit(1);
});
