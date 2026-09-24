require("dotenv").config({ quiet: true });

// Variáveis obrigatórias: sem elas a API não sobe (falha rápida e explícita).
const REQUIRED = ["DATABASE_URL", "JWT_SECRET", "ADMIN_USERNAME", "ADMIN_PASSWORD"];

function assertRequiredEnv() {
    const missing = REQUIRED.filter((k) => !process.env[k] || !process.env[k].trim());
    if (missing.length > 0) {
        console.error(
            `[config] Variáveis de ambiente obrigatórias ausentes: ${missing.join(", ")}. ` +
                "Veja o .env.example."
        );
        process.exit(1);
    }
    if (process.env.JWT_SECRET.length < 32) {
        console.warn("[config] JWT_SECRET tem menos de 32 caracteres — use um segredo mais longo em produção.");
    }
}

const list = (v) =>
    (v || "")
        .split(",")
        .map((s) => s.trim().replace(/\/+$/, ""))
        .filter(Boolean);

const config = {
    port: Number(process.env.PORT) || 3000,
    databaseUrl: process.env.DATABASE_URL,
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || "8h",
    adminUsername: (process.env.ADMIN_USERNAME || "").trim(),
    adminPassword: process.env.ADMIN_PASSWORD || "",
    frontendUrls: list(process.env.FRONTEND_URL),
    // URL pública do painel (usada nos links das notificações de lead)
    panelUrl: (process.env.PANEL_URL || list(process.env.FRONTEND_URL)[0] || "").replace(/\/+$/, ""),
    timezone: process.env.TZ_REPORTS || "America/Sao_Paulo",
    // Salt do hash de IP (tracking first-party anonimizado). Cai no JWT_SECRET se ausente.
    ipHashSalt: process.env.IP_HASH_SALT || process.env.JWT_SECRET || "",
    meta: {
        pixelId: process.env.META_PIXEL_ID || "",
        token: process.env.META_CAPI_TOKEN || "",
        testEventCode: process.env.META_TEST_EVENT_CODE || "",
        apiVersion: process.env.META_API_VERSION || "v21.0",
    },
    notify: {
        webhookUrl: process.env.LEAD_WEBHOOK_URL || "",
        webhookSecret: process.env.LEAD_WEBHOOK_SECRET || "",
        email: list(process.env.LEAD_NOTIFY_EMAIL),
        smtp: {
            host: process.env.SMTP_HOST || "",
            port: Number(process.env.SMTP_PORT) || 587,
            secure: process.env.SMTP_SECURE === "true",
            user: process.env.SMTP_USER || "",
            pass: process.env.SMTP_PASS || "",
            from: process.env.SMTP_FROM || "PUSH <no-reply@pushagencia.com.br>",
        },
    },
};

module.exports = { config, assertRequiredEnv };
